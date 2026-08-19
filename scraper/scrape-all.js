/**
 * Catálogo inicial + descoberta automática pela Shopee Affiliate Open API.
 *
 * FASE 1 (primeira carga): usa os produtos fixos fornecidos pelo dono do site
 * para nunca abrir vazio.
 * FASE 2 (a cada 30 min): consulta productOfferV2 por palavras-chave e
 * top-performing, escolhe os melhores produtos e publica o catálogo dinâmico.
 * Cada produto usa o offerLink afiliado devolvido pela API; se ausente,
 * generateShortLink é usado como fallback.
 *
 * Em caso de falha total da API, products.json e links.json anteriores são
 * preservados para o site nunca ficar vazio.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const FIXED_FILE = path.join(ROOT, 'fixed-products.json');
const CONFIG_FILE = path.join(ROOT, 'bot-config.json');
const OUTPUT_FILE = path.join(ROOT, 'products.json');
const LINKS_FILE = path.join(ROOT, 'links.json');
const META_FILE = path.join(ROOT, 'sync-meta.json');
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('❌ Credenciais ausentes. Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET.');
  process.exit(1);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sign(payload, timestamp) {
  const base = `${APP_ID}${timestamp}${payload}${APP_SECRET}`;
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

async function graphql(query) {
  const body = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(body, timestamp);

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
      'User-Agent': 'achadosshopeebsf/6.0'
    },
    body,
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Resposta não-JSON da Shopee (${response.status})`); }

  if (!response.ok) {
    const err = new Error(`Shopee HTTP ${response.status}: ${raw.slice(0, 500)}`);
    err.httpStatus = response.status;
    throw err;
  }
  if (json.errors?.length) {
    const first = json.errors[0];
    const code = first.extensions?.code;
    const err = new Error(`Shopee GraphQL${code ? ` [${code}]` : ''}: ${first.message || 'erro desconhecido'}`);
    err.code = code;
    throw err;
  }
  return json.data;
}

// Códigos documentados pela Shopee (ver docs da Affiliate Open API).
const SHOPEE_ERROR_HINTS = {
  10000: 'Erro interno da Shopee. Costuma se resolver sozinho na próxima execução.',
  10010: 'Erro de sintaxe na query GraphQL enviada pelo bot.',
  10020: 'Assinatura inválida — confira SHOPEE_APP_ID e SHOPEE_APP_SECRET nos Secrets do GitHub (podem estar errados, trocados ou com espaço extra).',
  10030: 'Limite de requisições da Shopee atingido (rate limit).',
  10035: 'Sua conta/app não tem acesso liberado à API — solicite/confirme o acesso no painel de afiliado da Shopee.',
  11001: 'Parâmetros inválidos na consulta.'
};

function explainShopeeError(error) {
  const code = error?.code;
  if (code && SHOPEE_ERROR_HINTS[code]) return `[${code}] ${SHOPEE_ERROR_HINTS[code]}`;
  return error?.message || 'erro desconhecido';
}

// Faz uma chamada mínima só para validar credenciais/acesso antes de gastar
// tempo com todas as keywords. Isso deixa claro no sync-meta.json se o problema
// é de credencial (o que trava QUALQUER atualização, sempre).
async function checkApiAccess() {
  try {
    await graphql(buildSearchQuery({ keyword: 'shopee', sortType: 2, page: 1, limit: 1 }));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: explainShopeeError(error), code: error?.code };
  }
}

function productFields() {
  return `
    itemId
    productName
    productLink
    offerLink
    imageUrl
    priceMin
    priceMax
    priceDiscountRate
    sales
    ratingStar
    commissionRate
    sellerCommissionRate
    shopeeCommissionRate
    commission
    shopId
    shopName
    shopType
    periodStartTime
    periodEndTime
  `;
}

function buildSearchQuery({ keyword, sortType = 1, page = 1, limit = 50, listType = null }) {
  const safeKeyword = JSON.stringify(String(keyword));
  const listTypeArg = Number.isInteger(listType) ? `, listType: ${listType}` : '';
  return `query {
    productOfferV2(
      keyword: ${safeKeyword},
      sortType: ${sortType},
      page: ${page},
      limit: ${limit}${listTypeArg}
    ) {
      nodes { ${productFields()} }
      pageInfo { page limit hasNextPage }
    }
  }`;
}

function buildTopQuery({ page = 1, limit = 50 }) {
  return `query {
    productOfferV2(
      listType: 2,
      sortType: 2,
      page: ${page},
      limit: ${limit}
    ) {
      nodes { ${productFields()} }
      pageInfo { page limit hasNextPage }
    }
  }`;
}

function buildShortLinkMutation(originUrl, subIds) {
  const safeUrl = JSON.stringify(String(originUrl));
  const safeSubIds = Array.isArray(subIds) && subIds.length
    ? `, subIds: ${JSON.stringify(subIds.slice(0, 5).map(String))}`
    : '';
  return `mutation {
    generateShortLink(input: { originUrl: ${safeUrl}${safeSubIds} }) { shortLink }
  }`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Roda `fn` com pequenos atrasos e nova tentativa em caso de rate limit (erro 10030
// da Shopee), para não perder produtos só porque o bot fez muitas chamadas seguidas.
async function withRateLimitRetry(fn, { retries = 3, baseDelayMs = 700 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRateLimit = error?.code === 10030 || /10030|rate limit/i.test(error.message || '');
      if (!isRateLimit || attempt === retries) throw error;
      const wait = baseDelayMs * (attempt + 1);
      console.warn(`  ⏳ rate limit da Shopee, aguardando ${wait}ms antes de tentar de novo…`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function generateAffiliateLink(product, config) {
  // O offerLink retornado pela API já vem com o tracking da SUA conta de afiliado
  // (a conta ligada ao SHOPEE_APP_ID/SHOPEE_APP_SECRET configurados nos Secrets).
  if (product?.offerLink) return product.offerLink;
  if (!product?.productLink) return '';
  try {
    const data = await withRateLimitRetry(() =>
      graphql(buildShortLinkMutation(product.productLink, config?.subIds))
    );
    await sleep(API_CALL_DELAY_MS);
    return data?.generateShortLink?.shortLink || '';
  } catch (error) {
    console.warn(`  ⚠ link afiliado não gerado para ${product.itemId}: ${error.message}`);
    return '';
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePrice(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  if (raw.includes(',')) return toNumber(raw.replace(/\./g, '').replace(',', '.'));
  return toNumber(raw);
}

function formatBRL(value) {
  const n = toNumber(value);
  if (!n) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatSales(value) {
  const n = toNumber(value);
  if (!n) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace('.', ',')} mi`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')} mil`;
  return String(Math.round(n));
}

function ratingNumber(value) {
  return toNumber(value);
}

function commissionPct(value) {
  const n = toNumber(value);
  return n > 1 ? n : n * 100;
}

// Categorias de maior consumo Shopee Brasil (relatório 2026 -> projeção 2027).
// Ordem importa: padrões mais específicos primeiro para evitar falso-positivo
// (ex.: "capa de chuva" não pode cair em Moda por causa de "capa").
function inferTag(name) {
  const n = String(name || '').toLowerCase();

  // Pets — antes de Casa/Auto para não confundir "cama pet" com Casa, etc.
  // "ra[cç][aã]o" isolado bate como substring dentro de "duração"/"decoração";
  // por isso exige contexto (ração de/para cão, gato, cachorro, pet).
  if (/areia (sanit[aá]ria|para gato)|comedouro|fonte de [aá]gua.*pet|antipulga|coleira pet|petisco|\bpet\b|para c[aã]es|para gato|ra[cç][aã]o (de |para )?(c[aã]o|gato|cachorro|pet)/i.test(n)) return 'Pets';

  // Auto & Moto
  if (/retrovisor|escapamento|moto\b|pneu|friso de roda|capa (para )?volante|automotiv|farol|para-choque|carburador/i.test(n)) return 'Auto & Moto';

  // Smartphones (mantido separado de Eletrônicos por ser categoria de ticket maior)
  if (/smartphone|celular|iphone|xiaomi|samsung|motorola|redmi|galaxy|android\b/i.test(n)) return 'Smartphones';

  // Cozinha
  if (/air ?fryer|panela|liquidificador|processador de alimentos|fatiador|descascador|forma de silicone|torneira|espremedor|utens[ií]lio.*cozinha|balan[cç]a.*cozinha/i.test(n)) return 'Cozinha';

  // Beleza
  if (/lip ?tint|batom|base l[ií]quida|blush|pincel|maquiagem|secadora|chapinha|s[eé]rum|skincare|corretivo|barbeador|beleza|cabelo|massageador facial|pistola de massagem/i.test(n)) return 'Beleza';

  // Casa, Decoração e Organização (categoria nº1 em GMV)
  if (/papel de parede|luminaria|lumin[áa]ria|sapateira|tapete|caixa organizadora|espelho|cortina|len[cç]ol|organizador|garrafa t[eé]rmica|penteadeira|umidificador|ventilador|capa de chuva|\bmop\b|pote herm[eé]tico|almofada|\bcasa\b/i.test(n)) return 'Casa';

  // Fitness / Bem-estar
  if (/whey|creatina|bcaa|fitness|academia|bicicleta erg|faixa el[aá]stica|pr[eé] ?treino|difusor|[oó]leo essencial|bioimped[aâ]ncia/i.test(n)) return 'Fitness';

  // Brinquedos e bebês
  if (/brinquedo|montessori|reborn|papelaria|caderno/i.test(n)) return 'Brinquedos';

  // Eletrônicos e acessórios de tecnologia
  if (/fone|bluetooth|tws|watch|rel[oó]gio|nfc|smart|eletr[oô]nico|power ?bank|carregador|cabo usb|ring ?light|projetor|impressora|notebook|mouse|teclado|hub usb|drone|r[aá]dio comunicador|c[aâ]mera de seguran[cç]a/i.test(n)) return 'Eletrônicos';

  // Moda
  if (/chinel|t[eê]nis|cal[cç]a|bermuda|\broupa\b|\bmoda\b|vestido|cropped|blazer|coturno|moc[aa]ssim|lingerie|conjunto fitness|moletom|blusa|camiseta|jaqueta|bolsa|bijuteria|[oó]culos de sol|sand[aá]lia/i.test(n)) return 'Moda';

  // Ferramentas e utilidades gerais
  if (/capacete|ferramenta|aspirador|limpeza/i.test(n)) return 'Acessórios';

  if (/devocional|livro/i.test(n)) return 'Livros';
  return 'Achado';
}

function scoreProduct(p, config) {
  const price = toNumber(p.priceMin);
  const sales = toNumber(p.sales);
  const rating = ratingNumber(p.ratingStar);
  const discount = toNumber(p.priceDiscountRate);
  const commission = commissionPct(p.commissionRate);

  // Escala logarítmica: recompensa preço baixo sem zerar itens de ticket maior
  // (ex.: smartphones), que continuam competitivos se tiverem boa nota/venda.
  const priceScore = price > 0 ? Math.max(0, 26 - Math.log10(price) * 9) : 10;
  const salesScore = Math.min(28, Math.log10(Math.max(1, sales)) * 6);
  const ratingScore = Math.min(24, rating * 4.8); // nota pesa mais: "produto de qualidade"
  const discountScore = Math.min(12, discount / 2);
  const commissionScore = Math.min(6, commission / 3);

  // Reforço para categorias de maior crescimento projetado até 2027
  // (bot-config.json > trendingCategoryBoost), sem excluir as demais.
  const boostMap = config?.trendingCategoryBoost || {};
  const categoryBoost = toNumber(boostMap[inferTag(p.productName)], 0);

  return priceScore + salesScore + ratingScore + discountScore + commissionScore + categoryBoost;
}

function normalizeProduct(product, affiliateLink) {
  const price = toNumber(product.priceMin || product.priceMax);
  const discount = toNumber(product.priceDiscountRate);
  const oldPrice = discount > 0 && price > 0 ? price / Math.max(0.01, 1 - discount / 100) : 0;
  const rating = ratingNumber(product.ratingStar);
  const sales = toNumber(product.sales);
  const commissionRate = commissionPct(product.commissionRate);

  return {
    id: String(product.itemId),
    title: product.productName || 'Produto Shopee',
    desc: `${product.shopName || 'Loja Shopee'}${rating ? ` · ${rating.toFixed(1)}★` : ''}${sales ? ` · ${formatSales(sales)} vendidos` : ''}`,
    image: product.imageUrl || '',
    tag: inferTag(product.productName),
    accent: '#ee4d2d',
    icon: '🛍️',
    now: formatBRL(price),
    old: oldPrice > price ? formatBRL(oldPrice) : '',
    off: discount > 0 ? `-${Math.round(discount)}%` : '',
    rating: rating ? rating.toFixed(1) : '',
    sales,
    salesLabel: formatSales(sales),
    commissionRate: commissionRate ? Number(commissionRate.toFixed(2)) : '',
    commission: product.commission || '',
    shopName: product.shopName || '',
    shopId: String(product.shopId || ''),
    itemId: String(product.itemId),
    productLink: product.productLink || '',
    affLink: affiliateLink || product.offerLink || '',
    category1: inferTag(product.productName),
    category2: '',
    category3: '',
    updatedAt: new Date().toISOString()
  };
}

function fixedAsFallback(fixed) {
  return fixed.map((p) => ({
    id: String(p.itemId),
    title: p.itemName,
    desc: `${p.shopName || 'Shopee'} · ${p.sales || ''} vendidos`,
    image: p.image || '',
    tag: inferTag(p.itemName),
    accent: '#ee4d2d',
    icon: '🛍️',
    now: p.price ? `R$ ${p.price}` : 'Consultar',
    old: '',
    off: '',
    rating: p.rating || '',
    sales: 0,
    salesLabel: p.sales || '',
    commissionRate: commissionPct(String(p.commissionRate || '').replace('%', '')),
    commission: p.commission || '',
    shopName: p.shopName || '',
    shopId: String(String(p.productLink || '').match(/\/product\/(\d+)\//)?.[1] || ''),
    itemId: String(p.itemId),
    productLink: p.productLink || '',
    affLink: p.offerLink || '',
    category1: inferTag(p.itemName),
    category2: '',
    category3: '',
    updatedAt: new Date().toISOString()
  }));
}

// sortType da Shopee p/ productOfferV2: 1=Relevância, 2=Vendidos, 3=Maior preço,
// 4=Menor preço, 5=Comissão. Girar entre eles a cada ciclo (baseado no runCount
// persistido no sync-meta.json) traz produtos DIFERENTES a cada execução, em vez
// de sempre repetir a mesma lista de "mais vendidos".
const SORT_TYPE_ROTATION = [2, 5, 1, 4];

function pickSortType(config, runCount) {
  if (config.rotateSortType === false) return 2;
  return SORT_TYPE_ROTATION[runCount % SORT_TYPE_ROTATION.length];
}

async function searchKeyword(keyword, config, runCount) {
  const results = [];
  const pages = Math.max(1, Math.min(config.pagesPerKeyword || 2, 5));
  const limit = Math.max(1, Math.min(config.limitPerQuery || 50, 500));
  const sortType = pickSortType(config, runCount);
  for (let page = 1; page <= pages; page++) {
    const data = await withRateLimitRetry(() =>
      graphql(buildSearchQuery({ keyword, sortType, page, limit }))
    );
    const connection = data?.productOfferV2;
    results.push(...(connection?.nodes || []));
    if (!connection?.pageInfo?.hasNextPage) break;
  }
  return results;
}

async function topPerforming(config) {
  const limit = Math.max(1, Math.min(config.topPerformingLimit || 50, 500));
  const data = await withRateLimitRetry(() => graphql(buildTopQuery({ page: 1, limit })));
  return data?.productOfferV2?.nodes || [];
}

// Atraso pequeno entre chamadas sequenciais à API da Shopee, só para não estourar
// o limite de requisições (erro 10030) quando o bot passa por várias keywords.
const API_CALL_DELAY_MS = 350;

async function collectDynamicProducts(config, diagnostics, runCount) {
  const map = new Map();
  const keywords = Array.isArray(config.keywords) ? config.keywords : [];

  for (const keyword of keywords) {
    try {
      const nodes = await searchKeyword(keyword, config, runCount);
      console.log(`  ✓ ${keyword}: ${nodes.length} produtos encontrados`);
      diagnostics.keywordCounts[keyword] = nodes.length;
      for (const node of nodes) {
        const id = String(node.itemId || '');
        if (id) map.set(id, node);
      }
    } catch (error) {
      const hint = explainShopeeError(error);
      console.warn(`  ⚠ ${keyword}: ${hint}`);
      diagnostics.keywordCounts[keyword] = 0;
      diagnostics.errors.push(`keyword "${keyword}": ${hint}`);
    }
    await sleep(API_CALL_DELAY_MS);
  }

  if (config.includeTopPerforming !== false) {
    try {
      const nodes = await topPerforming(config);
      console.log(`  ✓ top-performing: ${nodes.length} produtos encontrados`);
      diagnostics.topPerformingCount = nodes.length;
      for (const node of nodes) {
        const id = String(node.itemId || '');
        if (id) map.set(id, node);
      }
    } catch (error) {
      const hint = explainShopeeError(error);
      console.warn(`  ⚠ top-performing: ${hint}`);
      diagnostics.errors.push(`top-performing: ${hint}`);
    }
  }

  return [...map.values()];
}

// Nota mínima quando a Shopee informa avaliação — "produto de qualidade" pedido
// pelo usuário. Itens sem avaliação (rating 0/ausente) não são descartados só
// por isso, mas perdem pontos no ranqueamento (ver scoreProduct).
const MIN_RATING = 4.0;

function passesQualityBar(p, config) {
  const rating = ratingNumber(p.ratingStar);
  const minRating = config.minRating ?? MIN_RATING;
  if (rating > 0 && rating < minRating) return false;
  return true;
}

async function buildDynamicCatalog(nodes, config, diagnostics, previousIds) {
  const target = Math.max(1, config.maxProducts || 50);
  const beforeFilter = nodes.length;
  const filtered = nodes.filter((p) => p && p.itemId && p.productLink && p.imageUrl);
  const qualityFiltered = filtered.filter((p) => passesQualityBar(p, config));
  diagnostics.candidatesRaw = beforeFilter;
  diagnostics.candidatesAfterFilter = filtered.length;
  diagnostics.candidatesDroppedMissingFields = beforeFilter - filtered.length;
  diagnostics.candidatesDroppedLowRating = filtered.length - qualityFiltered.length;

  const ranked = qualityFiltered
    .map((p) => ({ p, score: scoreProduct(p, config), isFresh: !previousIds.has(String(p.itemId)) }))
    .sort((a, b) => b.score - a.score);

  // Prioridade #1: produtos que NÃO estavam no catálogo do ciclo anterior — é
  // isso que garante que o site sempre mostre coisa nova, sem repetição.
  // Só usamos itens repetidos se realmente faltar variedade fresca suficiente.
  const fresh = ranked.filter((r) => r.isFresh).slice(0, target * 3);
  const repeatable = ranked.filter((r) => !r.isFresh).slice(0, target * 2);
  diagnostics.freshCandidates = fresh.length;
  diagnostics.repeatableCandidates = repeatable.length;

  const results = [];
  const usedIds = new Set();
  let linkFailures = 0;

  for (const pool of [fresh, repeatable]) {
    for (const { p } of pool) {
      if (results.length >= target) break;
      const id = String(p.itemId);
      if (usedIds.has(id)) continue;
      const affiliateLink = await generateAffiliateLink(p, config);
      if (!affiliateLink) { linkFailures++; continue; }
      usedIds.add(id);
      results.push(normalizeProduct(p, affiliateLink));
    }
    if (results.length >= target) break;
  }

  diagnostics.affiliateLinkFailures = linkFailures;
  diagnostics.freshPublished = results.filter((r) => !previousIds.has(r.id)).length;
  diagnostics.repeatPublished = results.length - diagnostics.freshPublished;
  return results;
}

// Junta os produtos dinâmicos novos (sempre prioridade, pois são os mais frescos)
// com o catálogo anterior, preenchendo o restante até o alvo. Assim, mesmo que a
// API só devolva 5 produtos válidos na rodada, esses 5 já entram no ar — o site
// nunca fica "travado" esperando um número mínimo perfeito de itens.
function mergeWithPrevious(dynamic, previous, target) {
  const seen = new Set();
  const merged = [];

  for (const p of dynamic) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    merged.push({ ...p, source: 'api-dynamic' });
    if (merged.length >= target) return merged;
  }

  if (Array.isArray(previous)) {
    for (const p of previous) {
      if (!p || !p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      merged.push(p);
      if (merged.length >= target) break;
    }
  }

  return merged;
}

function writeSyncMeta({ startedAt, completedAt, productsCount, source, diagnostics, runCount }) {
  const intervalMinutes = 30;
  const nextUpdateAt = new Date(Date.parse(completedAt) + intervalMinutes * 60 * 1000).toISOString();
  writeJson(META_FILE, {
    status: diagnostics.apiOk === false ? 'degraded' : 'success',
    source,
    intervalMinutes,
    startedAt,
    completedAt,
    nextUpdateAt,
    productsCount,
    runCount,
    diagnostics
  });
}

async function main() {
  const config = readJson(CONFIG_FILE, {
    refreshIntervalMinutes: 30,
    maxProducts: 50,
    minDynamicProducts: 40,
    pagesPerKeyword: 1,
    limitPerQuery: 50,
    topPerformingLimit: 100,
    includeTopPerforming: true,
    rotateSortType: true,
    minRating: 4.0,
    keywords: [],
    subIds: ['achadosshopeebsf'],
    trendingCategoryBoost: {}
  });
  const fixed = readJson(FIXED_FILE, []);
  const previous = readJson(OUTPUT_FILE, []);
  const previousMeta = readJson(META_FILE, {});
  const runCount = Number.isFinite(previousMeta?.runCount) ? previousMeta.runCount + 1 : 0;
  const startedAt = new Date().toISOString();

  if (!Array.isArray(fixed) || fixed.length === 0) throw new Error('fixed-products.json está vazio.');

  console.log('🤖 Bot de achadinhos Shopee iniciado');
  console.log(`🟢 Catálogo inicial: ${fixed.length} produtos fixos`);
  console.log(`🔄 Depois, catálogo dinâmico: até ${config.maxProducts || 50} produtos`);
  console.log(`⏱️ Atualização programada: a cada ${config.refreshIntervalMinutes || 30} minutos`);
  console.log(`🔁 Execução nº ${runCount} · sortType desta rodada: ${pickSortType(config, runCount)}`);

  const diagnostics = {
    apiOk: true,
    keywordCounts: {},
    topPerformingCount: 0,
    candidatesRaw: 0,
    candidatesAfterFilter: 0,
    candidatesDroppedMissingFields: 0,
    candidatesDroppedLowRating: 0,
    freshCandidates: 0,
    repeatableCandidates: 0,
    freshPublished: 0,
    repeatPublished: 0,
    affiliateLinkFailures: 0,
    errors: []
  };

  const previousIds = new Set(
    (Array.isArray(previous) ? previous : []).map((p) => String(p?.id || '')).filter(Boolean)
  );

  console.log('\n🔎 Testando acesso à API antes de coletar…');
  const access = await checkApiAccess();
  if (!access.ok) {
    diagnostics.apiOk = false;
    diagnostics.errors.unshift(`checagem inicial: ${access.message}`);
    console.error(`❌ A Shopee recusou a chamada de teste: ${access.message}`);
    console.error('   Nenhum produto novo pode ser coletado enquanto isso não for resolvido.');
  } else {
    console.log('✅ Credenciais e acesso à API confirmados.');
  }

  let dynamic = [];
  if (access.ok) {
    try {
      const candidates = await collectDynamicProducts(config, diagnostics, runCount);
      console.log(`\n📊 ${candidates.length} candidatos únicos após coleta.`);
      dynamic = await buildDynamicCatalog(candidates, config, diagnostics, previousIds);
      console.log(`✅ ${dynamic.length} produtos dinâmicos (${diagnostics.freshPublished} novos, ${diagnostics.repeatPublished} repetidos do ciclo anterior por falta de opção fresca).`);
    } catch (error) {
      const hint = explainShopeeError(error);
      console.warn(`⚠️ Falha total na coleta dinâmica: ${hint}`);
      diagnostics.errors.push(`coleta: ${hint}`);
    }
  }

  const target = Math.max(1, config.maxProducts || 50);
  const minDynamic = Math.max(1, config.minDynamicProducts || 40);
  const previousIsDynamic = Array.isArray(previous) && previous.some((p) => p?.source === 'api-dynamic');

  let output;
  let source;
  if (dynamic.length >= target) {
    // Coleta cheia: publica só os novos, ranqueados.
    output = dynamic.map((p) => ({ ...p, source: 'api-dynamic' }));
    source = 'api-dynamic';
  } else if (dynamic.length > 0 && Array.isArray(previous) && previous.length > 0) {
    // Coleta parcial: publica os novos + completa com o catálogo anterior,
    // em vez de descartar tudo. O site sempre reflete o que a API conseguiu trazer.
    output = mergeWithPrevious(dynamic, previous, target);
    source = dynamic.length >= minDynamic ? 'api-dynamic' : 'api-dynamic-partial';
    console.warn(`⚠️ Só ${dynamic.length}/${target} produtos dinâmicos válidos; completando com o catálogo anterior.`);
  } else if (dynamic.length > 0) {
    // Coleta parcial na primeira execução (sem catálogo anterior para completar).
    output = dynamic.map((p) => ({ ...p, source: 'api-dynamic' }));
    source = 'api-dynamic-partial';
  } else if (Array.isArray(previous) && previous.length > 0) {
    // Falha total: mantém o catálogo anterior (nunca fica vazio).
    output = previous;
    source = previousIsDynamic ? 'previous-dynamic' : 'previous-fallback';
    console.warn('⚠️ Nenhum produto dinâmico válido nesta rodada; mantendo catálogo anterior.');
  } else {
    output = fixedAsFallback(fixed).map((p) => ({ ...p, source: 'fixed-fallback' }));
    source = 'fixed-fallback';
    console.warn('⚠️ Primeira execução sem retorno suficiente da API; publicando catálogo inicial fixo.');
  }

  const affiliateLinks = output.map((p) => p.affLink).filter(Boolean);
  writeJson(OUTPUT_FILE, output);
  writeJson(LINKS_FILE, affiliateLinks);
  const completedAt = new Date().toISOString();
  diagnostics.dynamicPublished = dynamic.length;
  writeSyncMeta({ startedAt, completedAt, productsCount: output.length, source, diagnostics, runCount });

  console.log(`\n✅ products.json: ${output.length} produtos`);
  console.log(`🔗 links.json: ${affiliateLinks.length} links de afiliado`);
  console.log(`📦 fonte publicada: ${source}`);
  if (diagnostics.errors.length) {
    console.log(`⚠️ erros registrados nesta rodada (ver sync-meta.json → diagnostics.errors):`);
    diagnostics.errors.forEach((e) => console.log(`   - ${e}`));
  }
  console.log(`⏱️ próxima atualização: 30 minutos após esta conclusão.`);
}

main().catch((error) => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
