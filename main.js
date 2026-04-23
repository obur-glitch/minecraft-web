import * as THREE from 'three';
import { PointerLockControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/PointerLockControls.js';

// ═══════════════════════════════════════════════════════════
//  HYPERS — main.js  |  Optimize Edilmiş Voxel Engine
//  Güncellemeler:
//    • Seed Re-Engineering: Biyom + oktav + genlik seed'den türetme
//    • Durability sistemi: maxDurability / currentDurability + görsel bar
//    • Gelişmiş Tooltip: İsim + Can + Lore hover sistemi
// ═══════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────
// 1. SABIT & TEMEL DEĞİŞKENLER
// ──────────────────────────────────────────────────────────
const CHUNK_SIZE   = 16;
const CHUNK_HEIGHT = 16;
const REACH        = 5;
const MAX_WEIGHT   = 100;
const GRAVITY      = 28.0;
const JUMP_FORCE   = 8.9;
const BASE_SPEED   = 74.3;
const WORLD_SEED   = (localStorage.getItem('worldSeed') || Math.random()) * 10000;

// ══════════════════════════════════════════════════════════
// 1B. SEED RE-ENGINEERING — Seed'den tüm dünya parametrelerini türet
// ══════════════════════════════════════════════════════════
const SeedEngine = (() => {
    // Hızlı deterministik hash fonksiyonu (Wang hash tabanlı)
    function hash(n) {
        let h = Math.floor(n) >>> 0;
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = (h >> 16) ^ h;
        return (h >>> 0) / 0xFFFFFFFF; // [0, 1]
    }

    // Seed'den farklı "kanallar" türet
    const s = WORLD_SEED;
    const h0 = hash(s);
    const h1 = hash(s + 1000.7);
    const h2 = hash(s + 2543.3);
    const h3 = hash(s + 7891.1);
    const h4 = hash(s + 3317.9);
    const h5 = hash(s + 5501.2);
    const h6 = hash(s + 8823.6);
    const h7 = hash(s + 1234.5);
    const h8 = hash(s + 6677.8);

    // ── Biyom tipi — 4 olası biyom
    // 0=düzlük, 1=dağlık, 2=çöl, 3=karlı_dağlar
    const biomeIndex = Math.floor(h0 * 4);
    const BIOME_NAMES = ['plains', 'mountains', 'desert', 'snowy'];
    const biome = BIOME_NAMES[biomeIndex];

    // ── Terrain parametreleri biyoma göre
    const BIOME_PARAMS = {
        plains:    { baseAmp: 3,  hillAmp: 6,  detailAmp: 1.5, baseFreq: 0.05, hillFreq: 0.03, detailFreq: 0.18 },
        mountains: { baseAmp: 14, hillAmp: 22, detailAmp: 5,   baseFreq: 0.06, hillFreq: 0.04, detailFreq: 0.14 },
        desert:    { baseAmp: 2,  hillAmp: 4,  detailAmp: 0.8, baseFreq: 0.04, hillFreq: 0.02, detailFreq: 0.22 },
        snowy:     { baseAmp: 10, hillAmp: 16, detailAmp: 3,   baseFreq: 0.055,hillFreq: 0.035,detailFreq: 0.16 },
    };
    const bp = BIOME_PARAMS[biome];

    // Seed varyasyonu uygula (her seed biraz farklı bir biyom versiyonu olsun)
    const ampMod   = 0.75 + h1 * 0.5;   // [0.75, 1.25]
    const freqMod  = 0.8  + h2 * 0.4;   // [0.8, 1.2]
    const offsetX  = h3 * 1000;
    const offsetZ  = h4 * 1000;

    const terrain = {
        biome,
        baseAmp:    bp.baseAmp   * ampMod,
        hillAmp:    bp.hillAmp   * ampMod,
        detailAmp:  bp.detailAmp * ampMod,
        baseFreq:   bp.baseFreq  * freqMod,
        hillFreq:   bp.hillFreq  * freqMod,
        detailFreq: bp.detailFreq* freqMod,
        offsetX,
        offsetZ,
        // Ağaç yoğunluğu
        treeChance: biome === 'desert' ? 0.002
                  : biome === 'snowy'  ? 0.008
                  : biome === 'mountains' ? 0.005
                  : 0.015,
    };

    // ── Nem & Sıcaklık haritası için frekanslar (blok seçimi için)
    const humidity  = h5; // [0,1]
    const tempVal   = h6; // [0,1]
    const oreRich   = 0.7 + h7 * 0.6;    // Cevher zenginliği çarpanı [0.7, 1.3]
    const caveSize  = 0.55 + h8 * 0.2;   // Mağara büyüklüğü [0.55, 0.75]

    return { terrain, humidity, tempVal, oreRich, caveSize, biome };
})();

// Blok ID eşleştirmesi (0 = hava)
const BLOCK_ID = {
    air:            0,
    bedrock:        1,
    stone:          2,
    dirt:           3,
    grass:          4,
    log:            5,
    leaves:         6,
    plank:          7,
    crafting_table: 8,
    furnace:        9,
    iron:           10,
    coal:           11,
    gold:           12,
    diamond:        13,
    copper:         14,
    lapis:          15,
    sand:           16,
    snow:           17,
};

// ID → isim
const ID_BLOCK = Object.fromEntries(Object.entries(BLOCK_ID).map(([k,v]) => [v, k]));

// Opak bloklar (face culling için)
const OPAQUE_IDS = new Set(Object.values(BLOCK_ID).filter(id => id !== BLOCK_ID.air && id !== BLOCK_ID.leaves));

// ──────────────────────────────────────────────────────────
// 2. ENVANTERLER
// ──────────────────────────────────────────────────────────
const inventorySlots = new Array(27).fill(null);
const hotbarSlots    = new Array(8).fill(null);
let selectedHotbarIndex = 0;

let craftGridSize = 2;
let craftSlots    = new Array(4).fill(null);
let craftResult   = null;

// ──────────────────────────────────────────────────────────
// 2B. DAYANIKLILIK (DURABILITY) SİSTEMİ
// ──────────────────────────────────────────────────────────
const ITEM_DURABILITY = {
    // Ahşap aletler
    wood_pickaxe:    { max: 59 },
    wood_axe:        { max: 59 },
    wood_shovel:     { max: 59 },
    wood_sword:      { max: 59 },
    // Taş aletler
    stone_pickaxe:   { max: 131 },
    stone_axe:       { max: 131 },
    stone_shovel:    { max: 131 },
    stone_sword:     { max: 131 },
    // Demir aletler
    iron_pickaxe:    { max: 250 },
    iron_axe:        { max: 250 },
    iron_shovel:     { max: 250 },
    iron_sword:      { max: 250 },
    // Altın aletler
    gold_pickaxe:    { max: 32 },
    gold_axe:        { max: 32 },
    gold_shovel:     { max: 32 },
    gold_sword:      { max: 32 },
    // Elmas aletler
    diamond_pickaxe: { max: 1561 },
    diamond_axe:     { max: 1561 },
    diamond_shovel:  { max: 1561 },
    diamond_sword:   { max: 1561 },
    // Bakır aletler
    copper_pickaxe:  { max: 190 },
    copper_axe:      { max: 190 },
    copper_shovel:   { max: 190 },
    copper_sword:    { max: 190 },
};

const ITEM_LORE = {
    wood_pickaxe:    'Kaba taşı deler,\ntaşı delmeye başlar.',
    wood_axe:        'Ormanlarda hüküm sürer.',
    wood_shovel:     'Toprak, kum ve çakılı kazar.',
    wood_sword:      'Acemi bir savaşçının silahı.',
    stone_pickaxe:   'Taşı ve demir cevherini kırar.',
    stone_axe:       'Keskin ama ağır bir balta.',
    stone_shovel:    'Dayanıklı kazma küreği.',
    stone_sword:     'Sert ve güvenilir bir kılıç.',
    iron_pickaxe:    'Elmas cevherini kırabilir.',
    iron_axe:        'Güçlü ve pratik bir balta.',
    iron_shovel:     'Verimli bir kazı aleti.',
    iron_sword:      'Demirin gücüyle yapılmış.',
    gold_pickaxe:    'Çok hızlı ama kırılgan.',
    gold_axe:        'Parlak ama hassas.',
    gold_shovel:     'Altın kadar değerli, altın kadar kısa ömürlü.',
    gold_sword:      'Gösterişli ama dayanıksız.',
    diamond_pickaxe: 'En sert malzemeleri deler.',
    diamond_axe:     'Efsanevi bir balta.',
    diamond_shovel:  'Neredeyse hiç yıpranmaz.',
    diamond_sword:   'Tüm düşmanları alt eder.',
    copper_pickaxe:  'Bakırın sertliğiyle yontulmuş.',
    copper_axe:      'Bakır çağının simgesi.',
    copper_shovel:   'Toprak sever bir alet.',
    copper_sword:    'Paslanmayan bir savaşçı.',
    dirt:            'Her şeyin başladığı yer.',
    stone:           'Dünyanın temeli.',
    grass:           'Üstünde çiçek açar.',
    log:             'Ormandan alınmış kereste.',
    leaves:          'Yapraklar rüzgarda sallanır.',
    plank:           'İşlenmiş ahşap tahta.',
    crafting_table:  'Ustanın en iyi dostu.',
    furnace:         'Cevherleri eriterek ingot yapar.',
    iron:            'Güçlü yapılar inşa edilir.',
    coal:            'Fırın için en iyi yakıt.',
    gold:            'Parlak ve değerli bir maden.',
    diamond:         'En sert doğal taş.',
    copper:          'Maden çağının metalı.',
    stick:           'Her aletin omurgası.',
    sand:            'Çöllerde bol miktarda bulunur.',
    snow:            'Soğuk iklimlerin örtüsü.',
};

/**
 * Bir slot için dayanıklılık başlat (sadece aletlere)
 */
function initDurability(item) {
    if (!item) return item;
    const def = ITEM_DURABILITY[item.type];
    if (!def) return item;
    if (item.maxDurability === undefined) {
        item.maxDurability     = def.max;
        item.currentDurability = def.max;
    }
    return item;
}

/**
 * Eldeki aleti yıprat. Can 0'a düşerse eşyayı sil.
 */
function damageHeldItem() {
    const item = hotbarSlots[selectedHotbarIndex];
    if (!item) return;
    if (!ITEM_DURABILITY[item.type]) return; // dayanıklılığı olmayan eşyalar (bloklar)
    initDurability(item);
    item.currentDurability--;
    if (item.currentDurability <= 0) {
        hotbarSlots[selectedHotbarIndex] = null;
        showChat('Sistem', `${item.type} kırıldı!`);
    }
    updateHotbarUI();
}

// ──────────────────────────────────────────────────────────
// 3. THREE.JS SETUP
// ──────────────────────────────────────────────────────────
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x87CEEB);
document.body.appendChild(renderer.domElement);
scene.fog = new THREE.FogExp2(0x87CEEB, 0.010);

const ambientLight = new THREE.AmbientLight(0xffffff, 2.5);
scene.add(ambientLight);
const sunLight = new THREE.DirectionalLight(0xffeedd, 1.0);
sunLight.position.set(15, 30, 15);
scene.add(sunLight);

const loader  = new THREE.TextureLoader();
const loadTex = path => {
    const t = loader.load(path);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
};

// ──────────────────────────────────────────────────────────
// 4. TEXTURE ATLAS
// ──────────────────────────────────────────────────────────
const blockTextures = {
    bedrock:        () => ['bedrock','bedrock','bedrock','bedrock','bedrock','bedrock'],
    stone:          () => ['stone','stone','stone','stone','stone','stone'],
    dirt:           () => ['dirt','dirt','dirt','dirt','dirt','dirt'],
    grass:          () => ['grass_block_side','grass_block_side','grass_block_top','dirt','grass_block_side','grass_block_side'],
    log:            () => ['oak_log','oak_log','oak_log_top','oak_log_top','oak_log','oak_log'],
    leaves:         () => ['oak_leaves','oak_leaves','oak_leaves','oak_leaves','oak_leaves','oak_leaves'],
    plank:          () => ['oak_planks','oak_planks','oak_planks','oak_planks','oak_planks','oak_planks'],
    crafting_table: () => ['crafting_table_side','crafting_table_side','crafting_table_top','crafting_table_bottom','crafting_table_front','crafting_table_front'],
    furnace:        () => ['furnace_side','furnace_front','furnace_top','furnace_bottom','furnace_side','furnace_side'],
    iron:           () => ['iron_ore','iron_ore','iron_ore','iron_ore','iron_ore','iron_ore'],
    coal:           () => ['coal_ore','coal_ore','coal_ore','coal_ore','coal_ore','coal_ore'],
    gold:           () => ['gold_ore','gold_ore','gold_ore','gold_ore','gold_ore','gold_ore'],
    diamond:        () => ['diamond_ore','diamond_ore','diamond_ore','diamond_ore','diamond_ore','diamond_ore'],
    copper:         () => ['copper_ore','copper_ore','copper_ore','copper_ore','copper_ore','copper_ore'],
    lapis:          () => ['lapis_ore','lapis_ore','lapis_ore','lapis_ore','lapis_ore','lapis_ore'],
    sand:           () => ['sand','sand','sand','sand','sand','sand'],
    snow:           () => ['snow','snow','snow','snow','snow','snow'],
};

const texCache = {};
function getTex(name) {
    if (!texCache[name]) texCache[name] = loadTex(`assets/textures/block/${name}.png`);
    return texCache[name];
}

const matCache = {};
function getBlockMats(blockName) {
    if (matCache[blockName]) return matCache[blockName];
    const faces = blockTextures[blockName]?.() || ['stone','stone','stone','stone','stone','stone'];
    const mats = faces.map(f => new THREE.MeshLambertMaterial({
        map: getTex(f),
        transparent: blockName === 'leaves',
        alphaTest: blockName === 'leaves' ? 0.5 : 0,
    }));
    matCache[blockName] = mats;
    return mats;
}

const mats = new Proxy({}, {
    get(_, key) { return getBlockMats(key); }
});

const destroyTextures = Array.from({ length: 9 }, (_, i) => loadTex(`assets/textures/block/destroy_stage_${i}.png`));
let destroyOverlay = null;

const geo = new THREE.BoxGeometry(1, 1, 1);

// ──────────────────────────────────────────────────────────
// 5. TEXTURE MAP (UI için)
// ──────────────────────────────────────────────────────────
const textureMap = {
    dirt:           'assets/textures/texturemap/Dirt_texturemap.png',
    stone:          'assets/textures/texturemap/stone_texturemap.png',
    log:            'assets/textures/texturemap/oak_log_texturemap.png',
    leaves:         'assets/textures/texturemap/leaves_texturemap.png',
    grass:          'assets/textures/texturemap/Grass_Block_texturemap.png',
    plank:          'assets/textures/texturemap/oak_planks_texturemap.png',
    crafting_table: 'assets/textures/texturemap/Crafting_Table_texturemap.png',
    furnace:        'assets/textures/texturemap/Furnace_texturemap.png',
    iron:           'assets/textures/texturemap/raw_iron_texturemap.png',
    gold:           'assets/textures/texturemap/raw_gold_texturemap.png',
    coal:           'assets/textures/texturemap/coal_texturemap.png',
    diamond:        'assets/textures/texturemap/diamond_texturemap.png',
    copper:         'assets/textures/texturemap/raw_copper_texturemap.png',
    stick:          'assets/textures/texturemap/Stick_texturemap.png',
    wood_pickaxe:   'assets/textures/texturemap/wooden_pickaxe_texturemap.png',
    wood_axe:       'assets/textures/texturemap/wooden_axe_texturemap.png',
    wood_shovel:    'assets/textures/texturemap/wooden_shovel_texturemap.png',
    wood_sword:     'assets/textures/texturemap/wooden_sword_texturemap.png',
    stone_pickaxe:  'assets/textures/texturemap/stone_pickaxe_texturemap.png',
    stone_axe:      'assets/textures/texturemap/stone_axe_texturemap.png',
    stone_shovel:   'assets/textures/texturemap/stone_shovel_texturemap.png',
    stone_sword:    'assets/textures/texturemap/stone_sword_texturemap.png',
    iron_pickaxe:   'assets/textures/texturemap/iron_pickaxe_texturemap.png',
    iron_axe:       'assets/textures/texturemap/iron_axe_texturemap.png',
    iron_shovel:    'assets/textures/texturemap/iron_shovel_texturemap.png',
    iron_sword:     'assets/textures/texturemap/iron_sword_texturemap.png',
    gold_pickaxe:   'assets/textures/texturemap/golden_pickaxe_texturemap.png',
    gold_axe:       'assets/textures/texturemap/golden_axe_texturemap.png',
    gold_shovel:    'assets/textures/texturemap/golden_shovel_texturemap.png',
    gold_sword:     'assets/textures/texturemap/golden_sword_texturemap.png',
    diamond_pickaxe:'assets/textures/texturemap/diamond_pickaxe_texturemap.png',
    diamond_axe:    'assets/textures/texturemap/diamond_axe_texturemap.png',
    diamond_shovel: 'assets/textures/texturemap/diamond_shovel_texturemap.png',
    diamond_sword:  'assets/textures/texturemap/diamond_sword_texturemap.png',
    copper_pickaxe: 'assets/textures/texturemap/copper_pickaxe_texturemap.png',
    copper_axe:     'assets/textures/texturemap/copper_axe_texturemap.png',
    copper_shovel:  'assets/textures/texturemap/copper_shovel_texturemap.png',
    copper_sword:   'assets/textures/texturemap/copper_sword_texturemap.png',
    sand:           'assets/textures/texturemap/sand_texturemap.png',
    snow:           'assets/textures/texturemap/snow_texturemap.png',
};

// ──────────────────────────────────────────────────────────
// 6. BLOK & ALET TANIMLARI
// ──────────────────────────────────────────────────────────
const BLOCK_DEFS = {
    bedrock:        { hardness: Infinity, tool: 'none' },
    dirt:           { hardness: 0.8,      tool: 'shovel' },
    stone:          { hardness: 4.0,      tool: 'pickaxe' },
    iron:           { hardness: 5.0,      tool: 'pickaxe' },
    coal:           { hardness: 4.2,      tool: 'pickaxe' },
    gold:           { hardness: 5.2,      tool: 'pickaxe' },
    diamond:        { hardness: 8.5,      tool: 'pickaxe' },
    copper:         { hardness: 4.8,      tool: 'pickaxe' },
    lapis:          { hardness: 4.0,      tool: 'pickaxe' },
    log:            { hardness: 3.0,      tool: 'axe' },
    leaves:         { hardness: 0.4,      tool: 'hand' },
    plank:          { hardness: 2.4,      tool: 'axe' },
    crafting_table: { hardness: 2.5,      tool: 'axe' },
    furnace:        { hardness: 4.0,      tool: 'pickaxe' },
    grass:          { hardness: 1.0,      tool: 'shovel' },
    sand:           { hardness: 0.75,     tool: 'shovel' },
    snow:           { hardness: 0.5,      tool: 'shovel' },
};

const TOOL_DEFS = {
    wood_pickaxe:    { type: 'pickaxe', speed: 2.0 },
    stone_pickaxe:   { type: 'pickaxe', speed: 4.0 },
    iron_pickaxe:    { type: 'pickaxe', speed: 6.0 },
    gold_pickaxe:    { type: 'pickaxe', speed: 10.0 },
    diamond_pickaxe: { type: 'pickaxe', speed: 9.0 },
    copper_pickaxe:  { type: 'pickaxe', speed: 3.5 },
    wood_axe:        { type: 'axe',     speed: 2.0 },
    stone_axe:       { type: 'axe',     speed: 4.0 },
    iron_axe:        { type: 'axe',     speed: 6.0 },
    gold_axe:        { type: 'axe',     speed: 10.0 },
    diamond_axe:     { type: 'axe',     speed: 9.0 },
    copper_axe:      { type: 'axe',     speed: 3.5 },
    wood_shovel:     { type: 'shovel',  speed: 2.0 },
    stone_shovel:    { type: 'shovel',  speed: 4.0 },
    iron_shovel:     { type: 'shovel',  speed: 6.0 },
    gold_shovel:     { type: 'shovel',  speed: 10.0 },
    diamond_shovel:  { type: 'shovel',  speed: 9.0 },
    copper_shovel:   { type: 'shovel',  speed: 3.5 },
    wood_sword:      { type: 'sword',   speed: 1.0 },
    stone_sword:     { type: 'sword',   speed: 1.0 },
    iron_sword:      { type: 'sword',   speed: 1.0 },
    gold_sword:      { type: 'sword',   speed: 1.0 },
    diamond_sword:   { type: 'sword',   speed: 1.0 },
    copper_sword:    { type: 'sword',   speed: 1.0 },
};

const ITEM_WEIGHTS = {
    dirt: 1, stone: 2, log: 3, leaves: 0.5, iron: 4,
    coal: 3, gold: 6, diamond: 8, copper: 3, plank: 1,
    stick: 0.5, crafting_table: 5, furnace: 5, sand: 1, snow: 0.5,
};

// ──────────────────────────────────────────────────────────
// 7. CRAFT TARİFLERİ
// ──────────────────────────────────────────────────────────
const recipeList = [
    { name: 'plank',          needs: { log: 1 },             gives: { type: 'plank',          count: 4 } },
    { name: 'stick',          needs: { plank: 2 },           gives: { type: 'stick',          count: 4 } },
    { name: 'crafting_table', needs: { plank: 4 },           gives: { type: 'crafting_table', count: 1 } },
    { name: 'furnace',        needs: { stone: 8 },           gives: { type: 'furnace',        count: 1 } },
    { name: 'wood_pickaxe',   needs: { plank: 3, stick: 2 }, gives: { type: 'wood_pickaxe',   count: 1 } },
    { name: 'wood_axe',       needs: { plank: 3, stick: 2 }, gives: { type: 'wood_axe',       count: 1 } },
    { name: 'wood_shovel',    needs: { plank: 1, stick: 2 }, gives: { type: 'wood_shovel',    count: 1 } },
    { name: 'wood_sword',     needs: { plank: 2, stick: 1 }, gives: { type: 'wood_sword',     count: 1 } },
    { name: 'stone_pickaxe',  needs: { stone: 3, stick: 2 }, gives: { type: 'stone_pickaxe',  count: 1 } },
    { name: 'stone_axe',      needs: { stone: 3, stick: 2 }, gives: { type: 'stone_axe',      count: 1 } },
    { name: 'stone_shovel',   needs: { stone: 1, stick: 2 }, gives: { type: 'stone_shovel',   count: 1 } },
    { name: 'stone_sword',    needs: { stone: 2, stick: 1 }, gives: { type: 'stone_sword',    count: 1 } },
    { name: 'iron_pickaxe',   needs: { iron: 3, stick: 2 },  gives: { type: 'iron_pickaxe',   count: 1 } },
    { name: 'iron_axe',       needs: { iron: 3, stick: 2 },  gives: { type: 'iron_axe',       count: 1 } },
    { name: 'iron_shovel',    needs: { iron: 1, stick: 2 },  gives: { type: 'iron_shovel',    count: 1 } },
    { name: 'iron_sword',     needs: { iron: 2, stick: 1 },  gives: { type: 'iron_sword',     count: 1 } },
    { name: 'gold_pickaxe',   needs: { gold: 3, stick: 2 },  gives: { type: 'gold_pickaxe',   count: 1 } },
    { name: 'gold_axe',       needs: { gold: 3, stick: 2 },  gives: { type: 'gold_axe',       count: 1 } },
    { name: 'gold_shovel',    needs: { gold: 1, stick: 2 },  gives: { type: 'gold_shovel',    count: 1 } },
    { name: 'gold_sword',     needs: { gold: 2, stick: 1 },  gives: { type: 'gold_sword',     count: 1 } },
    { name: 'copper_pickaxe', needs: { copper: 3, stick: 2 },gives: { type: 'copper_pickaxe', count: 1 } },
    { name: 'copper_axe',     needs: { copper: 3, stick: 2 },gives: { type: 'copper_axe',     count: 1 } },
    { name: 'copper_shovel',  needs: { copper: 1, stick: 2 },gives: { type: 'copper_shovel',  count: 1 } },
    { name: 'copper_sword',   needs: { copper: 2, stick: 1 },gives: { type: 'copper_sword',   count: 1 } },
    { name: 'diamond_pickaxe',needs: { diamond: 3, stick: 2 },gives:{ type: 'diamond_pickaxe',count: 1 } },
    { name: 'diamond_axe',    needs: { diamond: 3, stick: 2 },gives:{ type: 'diamond_axe',    count: 1 } },
    { name: 'diamond_shovel', needs: { diamond: 1, stick: 2 },gives:{ type: 'diamond_shovel', count: 1 } },
    { name: 'diamond_sword',  needs: { diamond: 2, stick: 1 },gives:{ type: 'diamond_sword',  count: 1 } },
];

// ══════════════════════════════════════════════════════════════
//  BÖLÜM A: OPTİMİZE CHUNK SİSTEMİ
// ══════════════════════════════════════════════════════════════
const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE;

function chunkIndex(lx, ly, lz) {
    return lx + lz * CHUNK_SIZE + ly * CHUNK_SIZE * CHUNK_SIZE;
}

const chunkData  = {};
const chunkMeshes= {};
let objects = [];

function getWorldBlock(wx, wy, wz) {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    const cd = chunkData[key];
    if (!cd) return BLOCK_ID.air;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    const ly = wy - cd.worldY;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE ||
        ly < 0 || ly >= CHUNK_HEIGHT) return BLOCK_ID.air;
    return cd.data[chunkIndex(lx, ly, lz)];
}

function setWorldBlock(wx, wy, wz, id) {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    const cd = chunkData[key];
    if (!cd) return;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    const ly = wy - cd.worldY;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE ||
        ly < 0 || ly >= CHUNK_HEIGHT) return;
    cd.data[chunkIndex(lx, ly, lz)] = id;
}

// ──────────────────────────────────────────────────────────
// A2. GELİŞMİŞ DÜNYA ÜRETİMİ (Seed Re-Engineering ile)
// ──────────────────────────────────────────────────────────
let renderDistance = 3;

/**
 * Seed'den türetilen parametrelerle çok katmanlı arazi yüksekliği.
 * Üç oktav: temel, tepe, detay — her biri farklı frekans ve genlik.
 */
function getTerrainHeight(x, z) {
    const T = SeedEngine.terrain;
    const ox = T.offsetX;
    const oz = T.offsetZ;

    // Temel yükseklik
    const base   = Math.sin((x + ox) * T.baseFreq)   * Math.cos((z + oz) * T.baseFreq)   * T.baseAmp;
    // Tepe tabakası
    const hill   = Math.sin((x + ox) * T.hillFreq + 0.5) * Math.sin((z + oz) * T.hillFreq + 0.8) * T.hillAmp;
    // İnce detay
    const detail = Math.cos((x + ox) * T.detailFreq) * Math.cos((z + oz) * T.detailFreq) * T.detailAmp;

    return Math.floor(base + hill + detail);
}

/**
 * Biyoma ve derinliğe göre cevher seç.
 * SeedEngine.oreRich çarpanı tüm olasılıkları etkiler.
 */
function pickOre(depth, r) {
    const or = SeedEngine.oreRich;
    if (depth > 4 && r < 0.004 * or) return 'diamond';
    if (depth > 3 && r < 0.012 * or) return 'gold';
    if (depth > 2 && r < 0.030 * or) return 'iron';
    if (depth > 2 && r < 0.050 * or) return 'copper';
    if (r < 0.070 * or)              return 'coal';
    if (r < 0.080)                   return 'lapis';
    return null;
}

/**
 * Biyoma göre yüzey blok tipi seç.
 * Çöl → kum, Karlı → kar, Diğer → çimen/toprak
 */
function getSurfaceBlock(yH, y, biome) {
    if (biome === 'desert') {
        if (y === yH) return 'sand';
        if (y >= yH - 3) return 'sand';
        return null; // stone devam
    }
    if (biome === 'snowy') {
        if (y === yH) return 'snow';
        if (y === yH - 1) return 'dirt';
        return null;
    }
    // plains / mountains
    if (y === yH) return 'grass';
    if (y >= yH - 3) return 'dirt';
    return null;
}

// ── SIMPLEX NOISE (Hafif 3D implementasyon, mağara için) ──────────────
const SimplexNoise3D = (() => {
    const grad3 = [
        [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
        [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
        [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
    ];
    function dot3(g,x,y,z){ return g[0]*x+g[1]*y+g[2]*z; }

    function create(seed) {
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        let s = (seed ^ (seed >>> 17)) >>> 0;
        for (let i = 255; i > 0; i--) {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            const j = s % (i + 1);
            [p[i], p[j]] = [p[j], p[i]];
        }
        const perm = new Uint8Array(512);
        for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

        function noise(xin, yin, zin) {
            const F3 = 1/3, G3 = 1/6;
            const s2 = (xin+yin+zin)*F3;
            const i = Math.floor(xin+s2), j = Math.floor(yin+s2), k = Math.floor(zin+s2);
            const t = (i+j+k)*G3;
            const X0=i-t, Y0=j-t, Z0=k-t;
            const x0=xin-X0, y0=yin-Y0, z0=zin-Z0;
            let i1,j1,k1,i2,j2,k2;
            if(x0>=y0){ if(y0>=z0){i1=1;j1=0;k1=0;i2=1;j2=1;k2=0}
            else if(x0>=z0){i1=1;j1=0;k1=0;i2=1;j2=0;k2=1}
            else{i1=0;j1=0;k1=1;i2=1;j2=0;k2=1}}
            else{ if(y0<z0){i1=0;j1=0;k1=1;i2=0;j2=1;k2=1}
            else if(x0<z0){i1=0;j1=1;k1=0;i2=0;j2=1;k2=1}
            else{i1=0;j1=1;k1=0;i2=1;j2=1;k2=0} }
            const x1=x0-i1+G3, y1=y0-j1+G3, z1=z0-k1+G3;
            const x2=x0-i2+2*G3, y2=y0-j2+2*G3, z2=z0-k2+2*G3;
            const x3=x0-1+3*G3, y3=y0-1+3*G3, z3=z0-1+3*G3;
            const ii=i&255, jj=j&255, kk=k&255;
            const gi0=perm[ii+perm[jj+perm[kk]]]%12;
            const gi1=perm[ii+i1+perm[jj+j1+perm[kk+k1]]]%12;
            const gi2=perm[ii+i2+perm[jj+j2+perm[kk+k2]]]%12;
            const gi3=perm[ii+1+perm[jj+1+perm[kk+1]]]%12;
            let n0=0,n1=0,n2=0,n3=0;
            let t0=0.6-x0*x0-y0*y0-z0*z0; if(t0>0){t0*=t0;n0=t0*t0*dot3(grad3[gi0],x0,y0,z0);}
            let t1=0.6-x1*x1-y1*y1-z1*z1; if(t1>0){t1*=t1;n1=t1*t1*dot3(grad3[gi1],x1,y1,z1);}
            let t2=0.6-x2*x2-y2*y2-z2*z2; if(t2>0){t2*=t2;n2=t2*t2*dot3(grad3[gi2],x2,y2,z2);}
            let t3=0.6-x3*x3-y3*y3-z3*z3; if(t3>0){t3*=t3;n3=t3*t3*dot3(grad3[gi3],x3,y3,z3);}
            return 32*(n0+n1+n2+n3);
        }
        return { noise };
    }
    return { create };
})();

// ── MAĞARA SİSTEMİ ──────────────────────────────────────────────────────
const caveCarver = (() => {
    const CFG = {
        scaleXZ: 0.055,
        scaleY:  0.08,
        octaves: [[0.55,1.0],[0.35,2.1],[0.10,4.2]],
        surfaceGuardRelative: 3,
        absoluteCeiling: 30,
        get threshold() { return SeedEngine.caveSize; }, // Seed'den türetildi
        carveableIds: null,
    };
    function getCarveableSet() {
        if (CFG.carveableIds) return CFG.carveableIds;
        CFG.carveableIds = new Set([
            BLOCK_ID.stone, BLOCK_ID.dirt, BLOCK_ID.grass,
            BLOCK_ID.iron, BLOCK_ID.coal, BLOCK_ID.gold,
            BLOCK_ID.diamond, BLOCK_ID.copper, BLOCK_ID.lapis,
            BLOCK_ID.sand,
        ]);
        return CFG.carveableIds;
    }

    let _noise = null;
    function getNoise() {
        if (!_noise) _noise = SimplexNoise3D.create(Math.floor(WORLD_SEED));
        return _noise;
    }

    function fbm3(nx, ny, nz) {
        const n = getNoise();
        let val = 0, amp = 0;
        for (let o = 0; o < CFG.octaves.length; o++) {
            const [w, sm] = CFG.octaves[o];
            val += n.noise(nx * sm, ny * sm, nz * sm) * w;
            amp += w;
        }
        return val / amp;
    }

    function getSurfaceY(wx, wz) { return getTerrainHeight(wx, wz); }

    function carve(cx, cz, data, worldY) {
        const carveable = getCarveableSet();
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const wx = cx * CHUNK_SIZE + x;
                const wz = cz * CHUNK_SIZE + z;
                const surfY = getSurfaceY(wx, wz);
                for (let ly = 0; ly < CHUNK_HEIGHT; ly++) {
                    const wy = worldY + ly;
                    if (wy >= surfY - CFG.surfaceGuardRelative) continue;
                    if (wy > CFG.absoluteCeiling) continue;
                    const idx = chunkIndex(x, ly, z);
                    if (!carveable.has(data[idx])) continue;
                    const nx = wx * CFG.scaleXZ;
                    const ny = wy * CFG.scaleY;
                    const nz = wz * CFG.scaleXZ;
                    const noiseVal = fbm3(nx, ny, nz);
                    const depthBelow = surfY - wy;
                    const fadeStart  = 4;
                    const fadeFactor = depthBelow < fadeStart ? depthBelow / fadeStart : 1.0;
                    const adjustedThreshold = CFG.threshold + (1 - fadeFactor) * 0.4;
                    if (noiseVal > adjustedThreshold) data[idx] = BLOCK_ID.air;
                }
            }
        }
    }
    return { carve };
})();

function generateChunkData(cx, cz) {
    let minY = Infinity, maxY = -Infinity;
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const h = getTerrainHeight(cx * CHUNK_SIZE + x, cz * CHUNK_SIZE + z);
            if (h - 5 < minY) minY = h - 5;
            if (h + 6 > maxY) maxY = h + 6;
        }
    }
    const worldY = minY;
    const data = new Uint8Array(CHUNK_VOLUME);
    const biome = SeedEngine.biome;

    const rng = (x, z, salt = 0) => {
        let h = (cx * CHUNK_SIZE + x) * 374761393 + (cz * CHUNK_SIZE + z) * 668265263 + salt * 2246822519;
        h ^= h >> 13; h *= 1274126177; h ^= h >> 16;
        return ((h >>> 0) % 10000) / 10000;
    };

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const wx = cx * CHUNK_SIZE + x;
            const wz = cz * CHUNK_SIZE + z;
            const yH = getTerrainHeight(wx, wz);

            for (let y = yH - 5; y <= yH; y++) {
                const ly = y - worldY;
                if (ly < 0 || ly >= CHUNK_HEIGHT) continue;

                let blockType;
                if (y === yH - 5) {
                    blockType = 'bedrock';
                } else {
                    // Biyoma özgü yüzey bloğu
                    const surfaceOverride = getSurfaceBlock(yH, y, biome);
                    if (surfaceOverride) {
                        blockType = surfaceOverride;
                    } else {
                        // Cevher veya taş
                        const depth = yH - y;
                        const r = rng(x, z, y);
                        const ore = pickOre(depth, r);
                        blockType = ore || 'stone';
                    }
                }
                data[chunkIndex(x, ly, z)] = BLOCK_ID[blockType] || BLOCK_ID.stone;
            }

            // ── Ağaç üretimi (biyoma göre yoğunluk)
            const treeProb = SeedEngine.terrain.treeChance;
            // Çöl: ağaç yok; karlı dağlar: seyrek; diğer: normal
            if (biome !== 'desert' && rng(x, z) < treeProb && yH >= -1) {
                const tH = 4 + Math.floor(rng(x, z, 1) * 2);
                for (let h = 1; h <= tH; h++) {
                    const ly = (yH + h) - worldY;
                    if (ly >= 0 && ly < CHUNK_HEIGHT)
                        data[chunkIndex(x, ly, z)] = BLOCK_ID.log;
                }
                for (let ly2 = -1; ly2 <= 2; ly2++) {
                    for (let lx2 = -2; lx2 <= 2; lx2++) {
                        for (let lz2 = -2; lz2 <= 2; lz2++) {
                            if (Math.abs(lx2) === 2 && Math.abs(lz2) === 2) continue;
                            if (ly2 === 2 && (Math.abs(lx2) > 1 || Math.abs(lz2) > 1)) continue;
                            const nx = x + lx2;
                            const nz = z + lz2;
                            if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) continue;
                            const ly = (yH + tH + ly2) - worldY;
                            if (ly >= 0 && ly < CHUNK_HEIGHT) {
                                const idx = chunkIndex(nx, ly, nz);
                                if (data[idx] === BLOCK_ID.air)
                                    data[idx] = BLOCK_ID.leaves;
                            }
                        }
                    }
                }
            }
        }
    }

    caveCarver.carve(cx, cz, data, worldY);
    return { data, worldY };
}

// ──────────────────────────────────────────────────────────
// A3. FACE CULLING + MESH OLUŞTURMA
// ──────────────────────────────────────────────────────────
const FACE_DIRS = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const FACE_VERTS = [
    [[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
    [[0,0,1],[0,1,1],[0,1,0],[0,0,0]],
    [[0,1,0],[0,1,1],[1,1,1],[1,1,0]],
    [[1,0,0],[1,0,1],[0,0,1],[0,0,0]],
    [[1,0,1],[1,1,1],[0,1,1],[0,0,1]],
    [[0,0,0],[0,1,0],[1,1,0],[1,0,0]],
];
const FACE_UVS     = [[0,0],[0,1],[1,1],[1,0]];
const FACE_NORMALS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

function buildChunkMesh(cx, cz) {
    const key = `${cx},${cz}`;
    const cd = chunkData[key];
    if (!cd) return null;

    if (chunkMeshes[key]) {
        chunkMeshes[key].forEach(m => {
            scene.remove(m);
            const i = objects.indexOf(m);
            if (i !== -1) objects.splice(i, 1);
        });
    }

    const meshData = {};

    for (let ly = 0; ly < CHUNK_HEIGHT; ly++) {
        const wy = cd.worldY + ly;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const wz = cz * CHUNK_SIZE + lz;
            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                const wx = cx * CHUNK_SIZE + lx;
                const blockId = cd.data[chunkIndex(lx, ly, lz)];
                if (blockId === BLOCK_ID.air) continue;
                const blockName = ID_BLOCK[blockId];
                if (!blockName) continue;

                for (let fi = 0; fi < 6; fi++) {
                    const [dx, dy, dz] = FACE_DIRS[fi];
                    const nx = wx + dx, ny = wy + dy, nz = wz + dz;
                    const neighborId = getWorldBlock(nx, ny, nz);
                    const neighborIsOpaque = OPAQUE_IDS.has(neighborId);
                    if (neighborIsOpaque) continue;
                    if (blockName === 'leaves' && neighborId === BLOCK_ID.leaves) continue;

                    if (!meshData[blockName]) {
                        meshData[blockName] = {
                            faceData: Array.from({length:6}, () => ({
                                positions: [], normals: [], uvs: [], indices: []
                            }))
                        };
                    }

                    const fd = meshData[blockName].faceData[fi];
                    const baseIdx = fd.positions.length / 3;
                    const verts = FACE_VERTS[fi];
                    const norm = FACE_NORMALS[fi];
                    for (const [vx, vy, vz] of verts) {
                        fd.positions.push(wx + vx, wy + vy, wz + vz);
                        fd.normals.push(...norm);
                    }
                    for (const [u, v] of FACE_UVS) fd.uvs.push(u, v);
                    fd.indices.push(baseIdx, baseIdx+1, baseIdx+2, baseIdx, baseIdx+2, baseIdx+3);
                }
            }
        }
    }

    const meshList = [];
    for (const [blockName, bData] of Object.entries(meshData)) {
        const blockMats = getBlockMats(blockName);
        for (let fi = 0; fi < 6; fi++) {
            const fd = bData.faceData[fi];
            if (fd.indices.length === 0) continue;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(fd.positions, 3));
            geom.setAttribute('normal',   new THREE.Float32BufferAttribute(fd.normals, 3));
            geom.setAttribute('uv',       new THREE.Float32BufferAttribute(fd.uvs, 2));
            geom.setIndex(fd.indices);
            const mat = blockMats[fi] || blockMats[0];
            const mesh = new THREE.Mesh(geom, mat);
            mesh.userData.chunkKey = key;
            mesh.userData.isBulkMesh = true;
            mesh.userData.bulkBlockType = blockName;
            scene.add(mesh);
            meshList.push(mesh);
            objects.push(mesh);
        }
    }
    chunkMeshes[key] = meshList;
    return meshList;
}

// ──────────────────────────────────────────────────────────
// A4. CHUNK YÖNETİMİ
// ──────────────────────────────────────────────────────────
const chunks = {};

function getPlayerChunk() {
    return {
        cx: Math.floor(camera.position.x / CHUNK_SIZE),
        cz: Math.floor(camera.position.z / CHUNK_SIZE)
    };
}

function createChunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (chunks[key]) return;
    chunkData[key] = generateChunkData(cx, cz);
    buildChunkMesh(cx, cz);
    chunks[key] = true;
}

function updateChunks() {
    const { cx, cz } = getPlayerChunk();
    for (let x = cx - renderDistance; x <= cx + renderDistance; x++)
        for (let z = cz - renderDistance; z <= cz + renderDistance; z++)
            createChunk(x, z);
}

function unloadChunks() {
    const { cx, cz } = getPlayerChunk();
    for (const key in chunks) {
        const [x, z] = key.split(',').map(Number);
        if (Math.abs(x - cx) > renderDistance + 1 || Math.abs(z - cz) > renderDistance + 1) {
            if (chunkMeshes[key]) {
                chunkMeshes[key].forEach(m => {
                    scene.remove(m);
                    const i = objects.indexOf(m);
                    if (i !== -1) objects.splice(i, 1);
                    m.geometry.dispose();
                });
                delete chunkMeshes[key];
            }
            delete chunkData[key];
            delete chunks[key];
        }
    }
}

// ──────────────────────────────────────────────────────────
// A5. BLOK KIRILMASI
// ──────────────────────────────────────────────────────────
function getHitBlock(intersect) {
    const point = intersect.point.clone().sub(
        intersect.face.normal.clone().multiplyScalar(0.5)
    );
    return { wx: Math.floor(point.x), wy: Math.floor(point.y), wz: Math.floor(point.z) };
}

function removeBlockAt(wx, wy, wz) {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const blockId = getWorldBlock(wx, wy, wz);
    if (blockId === BLOCK_ID.air) return null;
    const blockType = ID_BLOCK[blockId];
    setWorldBlock(wx, wy, wz, BLOCK_ID.air);
    rebuildChunkAndNeighbors(cx, cz);
    return blockType;
}

function placeBlockAt(wx, wy, wz, blockName) {
    const id = BLOCK_ID[blockName];
    if (!id) return;
    setWorldBlock(wx, wy, wz, id);
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    rebuildChunkAndNeighbors(cx, cz);
}

function rebuildChunkAndNeighbors(cx, cz) {
    const toRebuild = [[cx, cz], [cx+1, cz], [cx-1, cz], [cx, cz+1], [cx, cz-1]];
    for (const [x, z] of toRebuild) {
        const key = `${x},${z}`;
        if (chunks[key]) buildChunkMesh(x, z);
    }
}

// ──────────────────────────────────────────────────────────
// A6. ÇARPIŞMA SİSTEMİ
// ──────────────────────────────────────────────────────────
function isBlockSolid(wx, wy, wz) {
    const id = getWorldBlock(wx, wy, wz);
    return id !== BLOCK_ID.air && id !== BLOCK_ID.leaves;
}

function checkCollisionVoxel(pos) {
    const minX = pos.x - 0.3, maxX = pos.x + 0.3;
    const minY = pos.y - 1.75, maxY = pos.y + 0.1;
    const minZ = pos.z - 0.3, maxZ = pos.z + 0.3;
    for (let bx = Math.floor(minX); bx <= Math.floor(maxX); bx++)
        for (let by = Math.floor(minY); by <= Math.floor(maxY); by++)
            for (let bz = Math.floor(minZ); bz <= Math.floor(maxZ); bz++)
                if (isBlockSolid(bx, by, bz)) return true;
    return false;
}

function checkCollision() { return checkCollisionVoxel(camera.position); }

// ──────────────────────────────────────────────────────────
// 8. ENVANTER YARDIMCILARI
// ──────────────────────────────────────────────────────────
const MAX_STACK = 64;

function getItemCount(type) {
    let n = 0;
    for (const s of hotbarSlots)    if (s && s.type === type) n += s.count;
    for (const s of inventorySlots) if (s && s.type === type) n += s.count;
    return n;
}

function addToInventory(type, count) {
    // Dayanıklılığı olan eşyalar (aletler) birleştirilmez — her biri ayrı slot
    const hasDurability = !!ITEM_DURABILITY[type];
    if (!hasDurability) {
        for (const s of hotbarSlots) {
            if (!s || s.type !== type) continue;
            const room = MAX_STACK - s.count;
            const add  = Math.min(room, count);
            s.count += add; count -= add;
            if (count <= 0) { refreshAll(); return; }
        }
        for (const s of inventorySlots) {
            if (!s || s.type !== type) continue;
            const room = MAX_STACK - s.count;
            const add  = Math.min(room, count);
            s.count += add; count -= add;
            if (count <= 0) { refreshAll(); return; }
        }
    }
    while (count > 0) {
        const idx = hotbarSlots.indexOf(null);
        if (idx !== -1) {
            const add = Math.min(hasDurability ? 1 : MAX_STACK, count);
            const newItem = { type, count: add };
            if (hasDurability) initDurability(newItem);
            hotbarSlots[idx] = newItem;
            count -= add;
        } else {
            const idx2 = inventorySlots.indexOf(null);
            if (idx2 !== -1) {
                const add = Math.min(hasDurability ? 1 : MAX_STACK, count);
                const newItem = { type, count: add };
                if (hasDurability) initDurability(newItem);
                inventorySlots[idx2] = newItem;
                count -= add;
            } else { showChat('Sistem', 'Envanter dolu!'); break; }
        }
    }
    refreshAll();
}

function removeItem(type, amount) {
    const sources = [...hotbarSlots, ...inventorySlots];
    for (const s of sources) {
        if (!s || s.type !== type) continue;
        const take = Math.min(s.count, amount);
        s.count -= take; amount -= take;
        if (s.count <= 0) {
            const hi = hotbarSlots.indexOf(s);
            const ii = inventorySlots.indexOf(s);
            if (hi !== -1) hotbarSlots[hi] = null;
            if (ii !== -1) inventorySlots[ii] = null;
        }
        if (amount <= 0) break;
    }
}

function getInventoryWeight() {
    let w = 0;
    for (const s of [...hotbarSlots, ...inventorySlots])
        if (s) w += (ITEM_WEIGHTS[s.type] || 1) * s.count;
    return w;
}

function getSpeedMultiplier() {
    const ratio = getInventoryWeight() / MAX_WEIGHT;
    return Math.max(0.25, 1 - ratio);
}

// ──────────────────────────────────────────────────────────
// 9. ALET & KIRILMA HIZI
// ──────────────────────────────────────────────────────────
function getHeldItem() { return hotbarSlots[selectedHotbarIndex] || null; }

function getBreakTime(blockType) {
    const def = BLOCK_DEFS[blockType];
    if (!def) return 1;
    if (def.hardness === Infinity) return Infinity;
    const held = getHeldItem();
    if (!held) return def.hardness;
    const tool = TOOL_DEFS[held.type];
    if (!tool) return def.hardness;
    const correct = tool.type === def.tool;
    const speed   = correct ? tool.speed : 1;
    return def.hardness / speed;
}

// ──────────────────────────────────────────────────────────
// 10. CRAFT MANTIĞI
// ──────────────────────────────────────────────────────────
function canCraftRecipe(recipe) {
    for (const [item, need] of Object.entries(recipe.needs))
        if (getItemCount(item) < need) return false;
    return true;
}

function craftRecipe(recipe) {
    if (!canCraftRecipe(recipe)) { showChat('Sistem', 'Yeterli malzeme yok!'); return; }
    for (const [item, need] of Object.entries(recipe.needs)) removeItem(item, need);
    addToInventory(recipe.gives.type, recipe.gives.count);
    showChat('Sistem', `${recipe.gives.type} elde edildi (×${recipe.gives.count})`);
    renderRecipePanel();
    refreshAll();
}

function renderRecipePanel() {
    const panel = document.getElementById('recipe-panel');
    if (!panel) return;
    panel.innerHTML = '';
    recipeList.forEach(recipe => {
        const div = document.createElement('div');
        div.className = 'recipe ' + (canCraftRecipe(recipe) ? 'can-craft' : 'no-craft');
        const img = document.createElement('img');
        img.src = textureMap[recipe.gives.type] || '';
        div.appendChild(img);
        const lbl = document.createElement('span');
        lbl.className = 'recipe-result';
        lbl.textContent = recipe.gives.count > 1 ? recipe.gives.count : '';
        div.appendChild(lbl);
        div.onclick = () => craftRecipe(recipe);
        panel.appendChild(div);
    });
}

// ──────────────────────────────────────────────────────────
// 11. UI ÇİZİMİ — Dayanıklılık çubuğu dahil
// ──────────────────────────────────────────────────────────

/**
 * Dayanıklılık yüzdesine göre renk döner (yeşil→sarı→kırmızı)
 */
function getDurabilityColor(ratio) {
    if (ratio > 0.6) return '#4cfe88';
    if (ratio > 0.3) return '#f5c842';
    return '#ff4a4a';
}

/**
 * Slot elementine eşya çiz + dayanıklılık çubuğu ekle
 */
function drawItemInSlot(el, item) {
    el.innerHTML = '';
    if (!item) return;

    // Dayanıklılığı başlatılmamışsa başlat
    if (item && ITEM_DURABILITY[item.type]) initDurability(item);

    const src = textureMap[item.type];
    if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'width:100%;height:100%;image-rendering:pixelated;';
        el.appendChild(img);
    }

    if (item.count > 1) {
        const cnt = document.createElement('span');
        cnt.className = 'count-label';
        cnt.textContent = item.count;
        el.appendChild(cnt);
    }

    // Dayanıklılık çubuğu
    if (item.maxDurability !== undefined && item.currentDurability < item.maxDurability) {
        const ratio = item.currentDurability / item.maxDurability;
        const bar = document.createElement('div');
        bar.className = 'durability-bar';
        const fill = document.createElement('div');
        fill.className = 'durability-fill';
        fill.style.width = Math.max(0, ratio * 100) + '%';
        fill.style.background = getDurabilityColor(ratio);
        bar.appendChild(fill);
        el.appendChild(bar);
    }
}

function updateHotbarUI() {
    document.querySelectorAll('.hotbar-slot').forEach((el, i) => {
        drawItemInSlot(el, hotbarSlots[i]);
        el.classList.toggle('selected', i === selectedHotbarIndex);
    });
    updateHandItem();
}

function updateInventoryUI() {
    document.querySelectorAll('.inv-grid .inv-slot').forEach(el => {
        drawItemInSlot(el, inventorySlots[+el.dataset.slot]);
    });
}

function updateHandItem() {
    const hand = document.getElementById('player-hand');
    if (!hand) return;
    const item = getHeldItem();
    hand.src = (item && textureMap[item.type]) ? textureMap[item.type] : 'assets/ui/hand.png';
}

function refreshAll() {
    updateHotbarUI();
    updateInventoryUI();
    renderRecipePanel();
    renderCraftingGrid();
}

// ──────────────────────────────────────────────────────────
// 11B. TOOLTIP SİSTEMİ (Gelişmiş)
// ──────────────────────────────────────────────────────────
let tooltipEl = null;

function createTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'item-tooltip';
    tooltipEl.className = 'item-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);
}

function showTooltip(item, x, y) {
    if (!tooltipEl) createTooltip();
    if (!item) { hideTooltip(); return; }

    const durDef = ITEM_DURABILITY[item.type];
    if (durDef && !item.maxDurability) initDurability(item);

    let html = `<div class="tooltip-name">${item.type.replace(/_/g,' ')}</div>`;

    if (item.maxDurability !== undefined) {
        const ratio  = item.currentDurability / item.maxDurability;
        const color  = getDurabilityColor(ratio);
        html += `<div class="tooltip-durability">
            <span style="color:#aaa">Dayanıklılık: </span>
            <span style="color:${color}">${item.currentDurability}/${item.maxDurability}</span>
            <div class="tooltip-dur-bar">
                <div class="tooltip-dur-fill" style="width:${ratio*100}%;background:${color}"></div>
            </div>
        </div>`;
    }

    const lore = ITEM_LORE[item.type];
    if (lore) {
        html += `<div class="tooltip-lore">${lore.replace(/\n/g, '<br>')}</div>`;
    }

    tooltipEl.innerHTML = html;

    // Pozisyon: ekrandan taşmasın
    const tw = 200, th = 100;
    let tx = x + 14, ty = y - 12;
    if (tx + tw > innerWidth)  tx = x - tw - 8;
    if (ty + th > innerHeight) ty = y - th - 8;
    tooltipEl.style.left = tx + 'px';
    tooltipEl.style.top  = ty + 'px';
    tooltipEl.style.display = 'block';
}

function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
}

/** Slot elementlerine tooltip event'leri bağla */
function bindTooltips() {
    document.addEventListener('mouseover', e => {
        const slot = e.target.closest('.hotbar-slot, .inv-slot, .craft-input, .furnace-slot');
        if (!slot) { hideTooltip(); return; }

        let item = null;
        if (slot.dataset.index !== undefined) item = hotbarSlots[+slot.dataset.index];
        else if (slot.dataset.slot !== undefined) item = inventorySlots[+slot.dataset.slot];
        else if (slot.dataset.craft !== undefined) item = craftSlots[+slot.dataset.craft];

        if (item) showTooltip(item, e.clientX, e.clientY);
        else hideTooltip();
    });

    document.addEventListener('mousemove', e => {
        if (tooltipEl && tooltipEl.style.display !== 'none') {
            const tw = 200, th = 100;
            let tx = e.clientX + 14, ty = e.clientY - 12;
            if (tx + tw > innerWidth)  tx = e.clientX - tw - 8;
            if (ty + th > innerHeight) ty = e.clientY - th - 8;
            tooltipEl.style.left = tx + 'px';
            tooltipEl.style.top  = ty + 'px';
        }
    });

    document.addEventListener('mouseout', e => {
        const slot = e.target.closest('.hotbar-slot, .inv-slot, .craft-input, .furnace-slot');
        if (slot && !slot.contains(e.relatedTarget)) hideTooltip();
    });
}

// ──────────────────────────────────────────────────────────
// 12. CRAFTING GRID
// ──────────────────────────────────────────────────────────
function adjustCraftSlots(size) {
    const len = size * size;
    const next = new Array(len).fill(null);
    for (let i = 0; i < Math.min(len, craftSlots.length); i++) next[i] = craftSlots[i];
    craftSlots = next;
    craftGridSize = size;
}

function detectCraftingTableNearby() {
    const px = Math.round(camera.position.x);
    const py = Math.round(camera.position.y);
    const pz = Math.round(camera.position.z);
    for (let dx = -REACH-1; dx <= REACH+1; dx++)
        for (let dy = -REACH-1; dy <= REACH+1; dy++)
            for (let dz = -REACH-1; dz <= REACH+1; dz++)
                if (getWorldBlock(px+dx, py+dy, pz+dz) === BLOCK_ID.crafting_table) return true;
    return false;
}

function renderCraftingGrid() {
    const craftEl = document.getElementById('crafting-screen');
    if (!craftEl) return;

    let grid = craftEl.querySelector('.craft-grid');
    if (!grid) {
        grid = document.createElement('div');
        grid.className = 'craft-grid';
        craftEl.querySelector('.craft-body')?.appendChild(grid);
    }
    grid.style.gridTemplateColumns = `repeat(${craftGridSize}, 60px)`;
    if (craftSlots.length !== craftGridSize * craftGridSize) adjustCraftSlots(craftGridSize);

    grid.innerHTML = '';
    for (let i = 0; i < craftSlots.length; i++) {
        const el = document.createElement('div');
        el.className = 'craft-input inv-slot';
        el.dataset.craft = i;
        el.style.position = 'relative';
        drawItemInSlot(el, craftSlots[i]);
        grid.appendChild(el);
    }

    let resEl = craftEl.querySelector('#craft-result');
    if (!resEl) {
        resEl = document.createElement('div');
        resEl.id = 'craft-result';
        craftEl.querySelector('.craft-body')?.appendChild(resEl);
    }

    craftResult = null;
    for (const recipe of recipeList) {
        if (canCraftFromGrid(recipe)) { craftResult = recipe; break; }
    }

    if (craftResult) {
        drawItemInSlot(resEl, { type: craftResult.gives.type, count: craftResult.gives.count });
    } else {
        resEl.innerHTML = '';
    }
}

function canCraftFromGrid(recipe) {
    const gridCount = {};
    for (const slot of craftSlots) {
        if (!slot) continue;
        gridCount[slot.type] = (gridCount[slot.type] || 0) + slot.count;
    }
    for (const [item, need] of Object.entries(recipe.needs))
        if ((gridCount[item] || 0) < need) return false;
    return true;
}

function consumeCraftAndGive() {
    if (!craftResult) return;
    const needs = { ...craftResult.needs };
    for (let i = 0; i < craftSlots.length; i++) {
        const s = craftSlots[i];
        if (!s) continue;
        if (needs[s.type] > 0) {
            const take = Math.min(needs[s.type], s.count);
            s.count -= take;
            needs[s.type] -= take;
            if (s.count <= 0) craftSlots[i] = null;
        }
    }
    addToInventory(craftResult.gives.type, craftResult.gives.count);
    showChat('Sistem', `${craftResult.gives.type} üretildi!`);
    renderCraftingGrid();
    refreshAll();
}

// ──────────────────────────────────────────────────────────
// 13. MENÜ AÇMA/KAPAMA
// ──────────────────────────────────────────────────────────
let inventoryOpen = false;
let craftingOpen  = false;

function openMenu(type) {
    if (type === 'inventory') {
        inventoryOpen = !inventoryOpen;
        craftingOpen  = false;
    } else if (type === 'crafting') {
        craftingOpen  = !craftingOpen;
        inventoryOpen = false;
        if (craftingOpen) {
            const hasTable = detectCraftingTableNearby();
            adjustCraftSlots(hasTable ? 3 : 2);
            renderCraftingGrid();
        }
    }

    const invEl   = document.getElementById('inventory-screen');
    const craftEl = document.getElementById('crafting-screen');
    if (invEl)   invEl.style.display   = inventoryOpen ? 'block' : 'none';
    if (craftEl) craftEl.style.display = craftingOpen  ? 'block' : 'none';

    if (inventoryOpen || craftingOpen) {
        controls.unlock();
        renderRecipePanel();
        refreshAll();
    } else {
        if (!document.getElementById('furnace-screen')?.style.display?.includes('block') &&
            !settingsOpen) controls.lock();
    }
}

function closeAllMenus() {
    inventoryOpen = craftingOpen = false;
    const ids = ['inventory-screen','crafting-screen','furnace-screen'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    hideTooltip();
    if (!settingsOpen) controls.lock();
}

// ──────────────────────────────────────────────────────────
// 14. FIRIN (Furnace)
// ──────────────────────────────────────────────────────────
const smeltRecipes = {
    iron:   { fuel: 'coal', result: 'iron_ingot',   label: 'Iron Ingot' },
    gold:   { fuel: 'coal', result: 'gold_ingot',   label: 'Gold Ingot' },
    copper: { fuel: 'coal', result: 'copper_ingot', label: 'Copper Ingot' },
};

let furnaceInput  = null;
let furnaceFuel   = null;
let furnaceOutput = null;
let furnaceOpen   = false;

function openFurnace() {
    furnaceOpen = !furnaceOpen;
    const el = document.getElementById('furnace-screen');
    if (!el) return;
    el.style.display = furnaceOpen ? 'block' : 'none';
    if (furnaceOpen) controls.unlock();
    else if (!inventoryOpen && !craftingOpen && !settingsOpen) controls.lock();
}

document.getElementById('furnace-smelt')?.addEventListener('click', () => {
    if (!furnaceInput || !furnaceFuel) { showChat('Sistem', 'Girdi ve yakıt gerekli!'); return; }
    const recipe = smeltRecipes[furnaceInput.type];
    if (!recipe || furnaceFuel.type !== recipe.fuel) { showChat('Sistem', 'Geçersiz fırın kombinasyonu!'); return; }
    furnaceInput.count--;
    furnaceFuel.count--;
    if (furnaceInput.count <= 0) furnaceInput = null;
    if (furnaceFuel.count <= 0)  furnaceFuel  = null;
    addToInventory(recipe.result, 1);
    showChat('Sistem', `${recipe.label} üretildi!`);
    renderFurnaceUI();
});

function renderFurnaceUI() {
    const inEl  = document.getElementById('furnace-input');
    const fuEl  = document.getElementById('furnace-fuel');
    const outEl = document.getElementById('furnace-output');
    if (inEl)  drawItemInSlot(inEl,  furnaceInput);
    if (fuEl)  drawItemInSlot(fuEl,  furnaceFuel);
    if (outEl) {
        if (furnaceInput) {
            const r = smeltRecipes[furnaceInput.type];
            if (r) drawItemInSlot(outEl, { type: r.result, count: 1 });
            else   outEl.innerHTML = '';
        } else outEl.innerHTML = '';
    }
}

// ──────────────────────────────────────────────────────────
// 15. AYARLAR MENÜSÜ
// ──────────────────────────────────────────────────────────
let settingsOpen = false;

document.getElementById('closeSettings')?.addEventListener('click', () => {
    settingsOpen = false;
    const el = document.getElementById('settingsMenu');
    if (el) el.style.display = 'none';
    if (!inventoryOpen && !craftingOpen && !furnaceOpen) controls.lock();
});

document.getElementById('renderDistance')?.addEventListener('input', e => {
    renderDistance = +e.target.value;
});

document.getElementById('mouseSensitivity')?.addEventListener('input', e => {
    controls.pointerSpeed = +e.target.value;
});

// ──────────────────────────────────────────────────────────
// 16. SÜRÜKLE & BIRAK
// ──────────────────────────────────────────────────────────
let draggedItem  = null;
let dragSource   = null;
let dragFromIdx  = null;

const dragIcon = document.createElement('div');
dragIcon.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;display:none;width:48px;height:48px;';
document.body.appendChild(dragIcon);

window.addEventListener('mousemove', e => {
    if (draggedItem) {
        dragIcon.style.left = (e.clientX - 24) + 'px';
        dragIcon.style.top  = (e.clientY - 24) + 'px';
    }
});

document.addEventListener('mousedown', e => {
    if (!(inventoryOpen || craftingOpen)) return;
    const slot    = e.target.closest('.inv-slot');
    const cSlot   = e.target.closest('.craft-input');
    const hotSlot = e.target.closest('.hotbar-slot');

    let source = null, idx = null, item = null;
    if (slot && slot.dataset.slot !== undefined) {
        idx = +slot.dataset.slot;
        item = inventorySlots[idx];
        if (item) { inventorySlots[idx] = null; source = 'inventory'; }
    } else if (cSlot && cSlot.dataset.craft !== undefined) {
        idx = +cSlot.dataset.craft;
        item = craftSlots[idx];
        if (item) { craftSlots[idx] = null; source = 'craft'; }
    } else if (hotSlot && hotSlot.dataset.index !== undefined) {
        idx = +hotSlot.dataset.index;
        item = hotbarSlots[idx];
        if (item) { hotbarSlots[idx] = null; source = 'hotbar'; }
    }

    if (item) {
        draggedItem = item; dragSource = source; dragFromIdx = idx;
        dragIcon.innerHTML = `<img src="${textureMap[item.type]||''}" style="width:100%;image-rendering:pixelated;">`;
        dragIcon.style.display = 'block';
        hideTooltip();
        updateInventoryUI(); updateHotbarUI(); renderCraftingGrid();
    }
});

document.addEventListener('mouseup', e => {
    if (!draggedItem) {
        if (controls.isLocked) {
            isBreaking = false; breakTarget = null; breakTargetPos = null; breakProgress = 0;
            document.getElementById('break-ui').style.display = 'none';
        }
        return;
    }

    const slot     = e.target.closest('.inv-slot');
    const cSlot    = e.target.closest('.craft-input');
    const hotSlot  = e.target.closest('.hotbar-slot');
    const resultEl = e.target.closest('#craft-result');

    if (resultEl) {
        // sonuç slotuna bırakma — işleme
    } else if (slot && slot.dataset.slot !== undefined) {
        swap(inventorySlots, +slot.dataset.slot, 'inventory');
    } else if (cSlot && cSlot.dataset.craft !== undefined) {
        swap(craftSlots, +cSlot.dataset.craft, 'craft');
    } else if (hotSlot && hotSlot.dataset.index !== undefined) {
        swap(hotbarSlots, +hotSlot.dataset.index, 'hotbar');
    } else {
        returnDragged();
    }

    draggedItem = null;
    dragIcon.style.display = 'none';
    refreshAll();
});

function swap(arr, idx, dest) {
    if (arr[idx] && arr[idx].type === draggedItem.type && arr[idx].count < MAX_STACK &&
        !ITEM_DURABILITY[draggedItem.type]) {
        const add = Math.min(MAX_STACK - arr[idx].count, draggedItem.count);
        arr[idx].count += add;
        draggedItem.count -= add;
        if (draggedItem.count > 0) returnDragged();
    } else {
        const prev = arr[idx];
        arr[idx] = draggedItem;
        draggedItem = prev;
        if (prev) returnDragged();
    }
}

function returnDragged() {
    if (!draggedItem) return;
    const arr = dragSource === 'inventory' ? inventorySlots
              : dragSource === 'craft'     ? craftSlots
              :                              hotbarSlots;
    if (arr[dragFromIdx] === null) arr[dragFromIdx] = draggedItem;
    else addToInventory(draggedItem.type, draggedItem.count);
    draggedItem = null;
}

// ──────────────────────────────────────────────────────────
// 17. BLOK KOYMA
// ──────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
raycaster.far   = REACH + 1;
const pointer   = new THREE.Vector2(0, 0);
let isBreaking    = false;
let breakTarget   = null;
let breakTargetPos = null;
let breakProgress  = 0;
let breakTargetType = null;

function placeBlock(intersect) {
    const item = getHeldItem();
    if (!item || !BLOCK_ID[item.type]) return;

    const hitPos = intersect.point.clone().sub(
        intersect.face.normal.clone().multiplyScalar(0.5)
    );
    const bx = Math.floor(hitPos.x);
    const by = Math.floor(hitPos.y);
    const bz = Math.floor(hitPos.z);
    const nx = bx + Math.round(intersect.face.normal.x);
    const ny = by + Math.round(intersect.face.normal.y);
    const nz = bz + Math.round(intersect.face.normal.z);

    const playerBox = new THREE.Box3(
        new THREE.Vector3(camera.position.x - 0.3, camera.position.y - 1.75, camera.position.z - 0.3),
        new THREE.Vector3(camera.position.x + 0.3, camera.position.y + 0.1,  camera.position.z + 0.3)
    );
    const blockBox = new THREE.Box3(
        new THREE.Vector3(nx, ny, nz),
        new THREE.Vector3(nx+1, ny+1, nz+1)
    );
    if (playerBox.intersectsBox(blockBox)) return;
    if (getWorldBlock(nx, ny, nz) !== BLOCK_ID.air) return;

    placeBlockAt(nx, ny, nz, item.type);
    item.count--;
    if (item.count <= 0) hotbarSlots[selectedHotbarIndex] = null;
    updateHotbarUI();
    swingHand(true);
}

// ──────────────────────────────────────────────────────────
// 18. BLOK KIRMA DÖNGÜSÜ — Dayanıklılık entegrasyonu
// ──────────────────────────────────────────────────────────
function handleBlockBreaking(delta) {
    const hand = document.getElementById('player-hand');

    if (!isBreaking || !breakTargetPos) {
        hand?.classList.remove('swing-continuous');
        if (destroyOverlay) { scene.remove(destroyOverlay); destroyOverlay = null; }
        return;
    }

    hand?.classList.add('swing-continuous');

    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(objects, false);

    if (!hits.length || hits[0].distance > REACH) {
        hand?.classList.remove('swing-continuous');
        isBreaking = false; breakProgress = 0; breakTargetPos = null;
        document.getElementById('break-ui').style.display = 'none';
        if (destroyOverlay) { scene.remove(destroyOverlay); destroyOverlay = null; }
        return;
    }

    const hit = hits[0];
    const pos = getHitBlock(hit);

    if (!breakTargetPos ||
        pos.wx !== breakTargetPos.wx ||
        pos.wy !== breakTargetPos.wy ||
        pos.wz !== breakTargetPos.wz) {
        breakProgress = 0;
        breakTargetPos = pos;
        breakTargetType = ID_BLOCK[getWorldBlock(pos.wx, pos.wy, pos.wz)];
    }

    const breakTime = getBreakTime(breakTargetType || 'stone');
    if (breakTime === Infinity) return;

    breakProgress += delta / breakTime;

    const stage = Math.min(Math.floor(breakProgress * 9), 8);
    if (!destroyOverlay) {
        destroyOverlay = new THREE.Mesh(geo,
            new THREE.MeshBasicMaterial({ map: destroyTextures[stage], transparent: true, depthWrite: false }));
        destroyOverlay.scale.set(1.01, 1.01, 1.01);
        scene.add(destroyOverlay);
    }
    destroyOverlay.position.set(pos.wx + 0.5, pos.wy + 0.5, pos.wz + 0.5);
    destroyOverlay.material.map = destroyTextures[stage];
    destroyOverlay.material.needsUpdate = true;

    const bar = document.getElementById('break-bar');
    if (bar) bar.style.width = Math.min(breakProgress * 100, 100) + '%';

    if (breakProgress >= 1) {
        hand?.classList.remove('swing-continuous');
        if (destroyOverlay) { scene.remove(destroyOverlay); destroyOverlay = null; }

        const type = removeBlockAt(pos.wx, pos.wy, pos.wz);
        if (type) {
            spawnParticles(new THREE.Vector3(pos.wx+0.5, pos.wy+0.5, pos.wz+0.5), type);
            addToInventory(type, 1);
            showPickupLabel(type);
            if (type === 'crafting_table' && craftingOpen) openMenu('crafting');

            // ── Dayanıklılık düşür (sadece alet kullananlar)
            damageHeldItem();
        }

        isBreaking = false; breakProgress = 0; breakTargetPos = null;
        document.getElementById('break-ui').style.display = 'none';
    }
}

// ──────────────────────────────────────────────────────────
// 19. PARTİKÜLLER
// ──────────────────────────────────────────────────────────
const particles = [];

function spawnParticles(pos, type) {
    const tex = loader.load(textureMap[type] || 'assets/textures/block/dirt.png');
    for (let i = 0; i < 12; i++) {
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
        const p   = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), mat);
        p.position.copy(pos);
        p.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 5,
            Math.random() * 4,
            (Math.random() - 0.5) * 5
        );
        p.life = 0.8 + Math.random() * 0.4;
        scene.add(p);
        particles.push(p);
    }
}

function updateParticles(delta) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.position.addScaledVector(p.velocity, delta);
        p.velocity.y -= 9 * delta;
        p.life -= delta;
        p.material.opacity = Math.max(0, p.life / 1.2);
        if (p.life <= 0) { scene.remove(p); particles.splice(i, 1); }
    }
}

// ──────────────────────────────────────────────────────────
// 20. EL ANİMASYONU
// ──────────────────────────────────────────────────────────
let swingCooldown = 0;

function swingHand(force = false) {
    if (swingCooldown > 0 && !force) return;
    const hand = document.getElementById('player-hand');
    if (!hand) return;
    hand.classList.remove('swing-anim');
    void hand.offsetWidth;
    hand.classList.add('swing-anim');
    swingCooldown = 0.25;
}

// ──────────────────────────────────────────────────────────
// 21. CHAT
// ──────────────────────────────────────────────────────────
let chatOpen = false;
const chatInput    = document.getElementById('chatInput');
const chatMessages = document.getElementById('chatMessages');

function showChat(player, text) {
    if (!chatMessages) return;
    const div = document.createElement('div');
    div.className = 'chatMsg';
    div.textContent = `<${player}> ${text}`;
    chatMessages.appendChild(div);
    while (chatMessages.children.length > 8)
        chatMessages.removeChild(chatMessages.firstChild);
    setTimeout(() => div.remove(), 8000);
}

function showPickupLabel(type) {
    const el = document.createElement('div');
    el.className = 'pickup-label';
    el.textContent = `+1 ${type}`;
    el.style.left = (innerWidth / 2 - 30) + 'px';
    el.style.top  = (innerHeight / 2 + 40) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1000);
}

document.addEventListener('keydown', e => {
    if (e.key === 't' && !chatOpen && controls.isLocked) {
        chatOpen = true;
        controls.unlock();
        if (chatInput) { chatInput.style.display = 'block'; chatInput.focus(); }
    }
});

chatInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        const msg = chatInput.value.trim();
        if (msg) showChat('Oyuncu', msg);
        chatInput.value = '';
        chatInput.style.display = 'none';
        chatOpen = false;
        controls.lock();
    }
    if (e.key === 'Escape') {
        chatInput.style.display = 'none';
        chatOpen = false;
        controls.lock();
    }
});

// ──────────────────────────────────────────────────────────
// 22. KONTROLLER
// ──────────────────────────────────────────────────────────
const controls = new PointerLockControls(camera, document.body);

const crosshairEl = document.getElementById('crosshair');
controls.addEventListener('lock',   () => { if (crosshairEl) crosshairEl.style.display = 'block'; });
controls.addEventListener('unlock', () => { if (crosshairEl) crosshairEl.style.display = 'none';  });

document.addEventListener('click', () => {
    if (!inventoryOpen && !craftingOpen && !furnaceOpen && !chatOpen && !settingsOpen && !controls.isLocked)
        controls.lock();
});

const move = { f: false, b: false, l: false, r: false };
let velocity = new THREE.Vector3();
let canJump  = false;

document.addEventListener('keydown', e => {
    if (chatOpen) return;
    if (e.code === 'KeyW')  move.f = true;
    if (e.code === 'KeyS')  move.b = true;
    if (e.code === 'KeyA')  move.l = true;
    if (e.code === 'KeyD')  move.r = true;
    if (e.code === 'Space' && canJump) { velocity.y = JUMP_FORCE; canJump = false; }

    if (e.code === 'KeyE')  { closeAllMenus(); openMenu('inventory'); }
    if (e.code === 'KeyC')  { closeAllMenus(); openMenu('crafting');  }
    if (e.code === 'KeyF')  openFurnace();
    if (e.code === 'Escape') closeAllMenus();

    if (e.code === 'KeyP') {
        settingsOpen = !settingsOpen;
        const el = document.getElementById('settingsMenu');
        if (el) el.style.display = settingsOpen ? 'block' : 'none';
        if (settingsOpen) controls.unlock(); else controls.lock();
    }

    if (e.code.startsWith('Digit')) {
        if (inventoryOpen || craftingOpen) return;
        const n = parseInt(e.code.replace('Digit', '')) - 1;
        if (n >= 0 && n < 8) { selectedHotbarIndex = n; updateHotbarUI(); }
    }
});

document.addEventListener('keyup', e => {
    if (e.code === 'KeyW') move.f = false;
    if (e.code === 'KeyS') move.b = false;
    if (e.code === 'KeyA') move.l = false;
    if (e.code === 'KeyD') move.r = false;
});

window.addEventListener('wheel', e => {
    if (inventoryOpen || craftingOpen) return;
    selectedHotbarIndex = (selectedHotbarIndex + (e.deltaY > 0 ? 1 : -1) + 8) % 8;
    updateHotbarUI();
}, { passive: true });

document.addEventListener('mousedown', e => {
    if ((inventoryOpen || craftingOpen) && e.target.closest('#craft-result')) {
        consumeCraftAndGive();
        return;
    }
    if (inventoryOpen || craftingOpen || furnaceOpen || chatOpen) return;
    if (!controls.isLocked) return;

    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(objects, false);

    if (e.button === 0) {
        if (hits.length && hits[0].distance <= REACH) {
            breakTarget     = hits[0].object;
            breakTargetPos  = getHitBlock(hits[0]);
            breakTargetType = ID_BLOCK[getWorldBlock(breakTargetPos.wx, breakTargetPos.wy, breakTargetPos.wz)];
            isBreaking      = true;
            breakProgress   = 0;
            document.getElementById('break-ui').style.display = 'block';
        }
    } else if (e.button === 2) {
        if (hits.length && hits[0].distance <= REACH) {
            const hit = hits[0];
            const pos = getHitBlock(hit);
            const blockId = getWorldBlock(pos.wx, pos.wy, pos.wz);
            const blockType = ID_BLOCK[blockId];
            if (blockType === 'crafting_table') {
                craftGridSize = 3; adjustCraftSlots(3);
                openMenu('crafting');
            } else if (blockType === 'furnace') {
                openFurnace();
            } else {
                placeBlock(hit);
            }
        } else {
            swingHand();
        }
    }
});

document.addEventListener('mouseup', e => {
    if (e.button === 0 && !draggedItem) {
        isBreaking = false; breakTarget = null; breakTargetPos = null; breakProgress = 0;
        document.getElementById('break-ui').style.display = 'none';
        const bar = document.getElementById('break-bar');
        if (bar) bar.style.width = '0%';
    }
});

window.addEventListener('contextmenu', e => e.preventDefault());

// ──────────────────────────────────────────────────────────
// 23. FİZİK
// ──────────────────────────────────────────────────────────
// (checkCollision yukarıda tanımlı)

// ──────────────────────────────────────────────────────────
// 24. FPS SAYACI
// ──────────────────────────────────────────────────────────
let fps = 60, fpsTimer = 0, frameCount = 0;
const fpsEl = document.getElementById('fpsCounter');

// ──────────────────────────────────────────────────────────
// 25. ANA DÖNGÜ
// ──────────────────────────────────────────────────────────
let prevTime = performance.now();

function animate() {
    requestAnimationFrame(animate);
    const now   = performance.now();
    const delta = Math.min((now - prevTime) / 1000, 0.1);
    prevTime    = now;

    frameCount++; fpsTimer += delta;
    if (fpsTimer >= 0.5) {
        fps = Math.round(frameCount / fpsTimer);
        if (fpsEl) fpsEl.textContent = `FPS: ${fps} | ${SeedEngine.biome.toUpperCase()}`;
        frameCount = 0; fpsTimer = 0;
    }

    swingCooldown = Math.max(0, swingCooldown - delta);

    if (controls.isLocked) {
        const hand = document.getElementById('player-hand');
        if (hand) {
            const walking = move.f || move.b || move.l || move.r;
            hand.classList.toggle('bob-anim', walking && !isBreaking);
        }

        velocity.y -= GRAVITY * delta;
        velocity.x -= velocity.x * 10 * delta;
        velocity.z -= velocity.z * 10 * delta;

        const spd = BASE_SPEED * getSpeedMultiplier();
        if (move.f) velocity.z += spd * delta;
        if (move.b) velocity.z -= spd * delta;
        if (move.l) velocity.x -= spd * delta;
        if (move.r) velocity.x += spd * delta;

        const oldPos = camera.position.clone();

        controls.moveRight(velocity.x * delta);
        controls.moveForward(velocity.z * delta);
        if (checkCollision()) {
            camera.position.x = oldPos.x;
            camera.position.z = oldPos.z;
            velocity.x = velocity.z = 0;
        }

        camera.position.y += velocity.y * delta;
        if (checkCollision()) {
            if (velocity.y < 0) canJump = true;
            camera.position.y = oldPos.y;
            velocity.y = 0;
        }

        handleBlockBreaking(delta);
    }

    updateParticles(delta);
    updateChunks();
    unloadChunks();
    renderer.render(scene, camera);
}

// ──────────────────────────────────────────────────────────
// 26. ANA MENÜ
// ──────────────────────────────────────────────────────────
const mainMenu  = document.getElementById('main-menu');
const singleBtn = document.getElementById('singleplayer-btn');
const createBtn = document.getElementById('createworld-btn');

function startGame() {
    if (mainMenu) mainMenu.style.display = 'none';
    controls.lock();
    if (crosshairEl) crosshairEl.style.display = 'block';
    showChat('Sistem', `Hypers dünyasına hoş geldin! Biyom: ${SeedEngine.biome}`);
}

singleBtn?.addEventListener('click', startGame);
createBtn?.addEventListener('click', () => {
    localStorage.setItem('worldSeed', Math.random());
    location.reload();
});

// ──────────────────────────────────────────────────────────
// 27. PENCERE YENİDEN BOYUTLANDIRMA
// ──────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});

// ──────────────────────────────────────────────────────────
// 28. BAŞLANGIÇ
// ──────────────────────────────────────────────────────────
createTooltip();
bindTooltips();
camera.position.set(8, 20, 8);
animate();
refreshAll();