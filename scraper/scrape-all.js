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
// Memória persistente entre execuções (commitada pelo workflow) de QUANDO cada
// produto foi publicado por último. É isso que garante "sempre produtos novos"
// de verdade, em vez de só comparar com o ciclo imediatamente anterior.
const HISTORY_FILE = path.join(ROOT, 'product-history.json');
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
      'User-Agent': 'achadosshopeebsf/6.1'
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

// Consulta direta por itemId (+shopId). Usada só para PRODUTOS FIXADOS.
function buildItemQuery({ itemId, shopId = '' }) {
  const shopArg = /^\d+$/.test(String(shopId)) ? `, shopId: ${shopId}` : '';
  return `query {
    productOfferV2(itemId: ${itemId}${shopArg}, page: 1, limit: 5) {
      nodes { ${productFields()} }
      pageInfo { page limit hasNextPage }
    }
  }`;
}

function buildTopQuery({ page = 1, limit = 50, includeSortType = true }) {
  // listType 2 = "top performing" da Shopee. Em algumas contas/momentos a API
  // rejeita esse listType combinado com sortType (erro [11001] Parâmetros
  // inválidos) — por isso topPerforming() tenta primeiro com sortType e,
  // se a Shopee recusar especificamente por parâmetro inválido, tenta de
  // novo sem sortType antes de desistir.
  const sortPart = includeSortType ? 'sortType: 2,' : '';
  return `query {
    productOfferV2(
      listType: 2,
      ${sortPart}
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

// Roda `fn` com pequenos atrasos e nova tentativa em caso de erro transitório
// da Shopee: 10030 (rate limit) e 10000 (erro interno — a própria Shopee
// documenta que "costuma se resolver sozinho", e a forma de resolver sozinho
// É tentar de novo). Sem isso, uma leva de erros 10000 em sequência (comum
// quando muitas keywords são consultadas seguidas) perdia dezenas de
// palavras-chave inteiras por rodada, mesmo sendo um problema passageiro.
const TRANSIENT_ERROR_CODES = new Set([10030, 10000]);

async function withRateLimitRetry(fn, { retries = 3, baseDelayMs = 700 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isTransient = TRANSIENT_ERROR_CODES.has(error?.code) || /10030|10000|rate limit/i.test(error.message || '');
      if (!isTransient || attempt === retries) throw error;
      const wait = baseDelayMs * (attempt + 1);
      console.warn(`  ⏳ erro transitório da Shopee${error?.code ? ` (${error.code})` : ''}, aguardando ${wait}ms antes de tentar de novo…`);
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


function normalizedShopTypes(value) {
  if (Array.isArray(value)) return value.map((v) => Number(v)).filter(Number.isFinite);
  if (value === null || value === undefined || value === '') return [];
  const n = Number(value);
  return Number.isFinite(n) ? [n] : [];
}

function shopNameLooksInternational(shopName, config) {
  const name = normalizeDedupeText(shopName);
  const blocked = Array.isArray(config?.blockedInternationalShopNamePatterns)
    ? config.blockedInternationalShopNamePatterns
    : [];
  return blocked.some((pattern) => {
    const token = normalizeDedupeText(pattern);
    return token && name.includes(token);
  });
}

function isBrazilMarketplaceOffer(product, config) {
  const link = String(product?.productLink || '');
  if (!/^https?:\/\/(?:www\.)?shopee\.com\.br\//i.test(link)) return false;

  const allowed = new Set(
    (Array.isArray(config?.allowedShopTypes) ? config.allowedShopTypes : [1, 2, 4])
      .map(Number)
      .filter(Number.isFinite)
  );
  const shopTypes = normalizedShopTypes(product?.shopType);
  if (!shopTypes.length) return config?.allowUnknownShopType === true;
  if (!shopTypes.some((type) => allowed.has(type))) return false;
  if (shopNameLooksInternational(product?.shopName, config)) return false;
  return true;
}

function catalogMinPrice(product) {
  // Usa o MENOR preço da oferta para impedir que uma variação abaixo de R$10
  // passe no catálogo apenas porque outra variação é mais cara.
  return toNumber(product?.priceMin || product?.priceMax);
}

// Categorias de maior consumo Shopee Brasil (relatório 2026 -> projeção 2027).
// Ordem importa: padrões mais específicos primeiro para evitar falso-positivo
// (ex.: "capa de chuva" não pode cair em Moda por causa de "capa").
// Sinaliza que o produto é claramente roupa/acessório (não o aparelho em si),
// mesmo que o texto mencione "celular"/marca de telefone em algum ponto —
// ex.: "bolso para celular", "capinha iphone", "suporte para smartphone".
function looksLikePhoneAccessoryOrUnrelated(n) {
  return /capinha|capa (para|de)|pel[ií]cula|suporte|\bcase\b|bolso|porta[- ]?celular|cord[ãa]o|bra[çc]adeira|pop ?socket|trip[ée]|\bcabo\b|carregador|\bfone\b|power ?bank|adaptador|\bhub\b|\banel\b|\bshort\b|bermuda|cal[çc]a\b|legging|compress[ãa]o|academia|treino|moletom|jaqueta|camiseta|regata|\bkit\s*\d|cart[aã]o de mem[oó]ria|micro ?sd|pen ?drive|pendrive|\botg\b|\bssd\b|\bhd\b|microfone|lapela|caneta|gimbal|estabilizador|selfie|ring ?light|gamepad|joystick|\blente\b|tela (para|de)|bateria (para|de)|carca[cç]a|protetor|vidro/i.test(n);
}

// Só considera "o aparelho em si" quando o texto tem marca+modelo de celular
// de verdade, ou "smartphone"/"celular" isolado (sem contexto de roupa/
// acessório) — normalmente acompanhado de capacidade em GB, como listagens
// reais de celular costumam vir ("Redmi Note 13 128GB", "iPhone 15 256GB").
function isRealPhoneListing(n) {
  if (looksLikePhoneAccessoryOrUnrelated(n)) return false;
  return (
    /\bsmartphone\b/i.test(n) ||
    /\biphone\s*\d/i.test(n) ||
    /\bredmi\b/i.test(n) ||
    /\bpoco\s*[a-z]?\s*\d/i.test(n) ||
    /\bgalaxy\s*[as]\d/i.test(n) ||
    /\bmoto\s*g\d/i.test(n) ||
    /\bmoto\s*(e|edge)\s?\d/i.test(n) ||
    /\bgalaxy\s*[ams]\s?\d/i.test(n) ||
    /\b(realme|infinix|tecno|zte|nokia|honor|oppo|xiaomi|multilaser|zenfone)\b[^.]*\b\d+\s?gb\b/i.test(n) ||
    /\bcelular\b[^.]*\b(5g|4g|dual\s?chip|desbloqueado)\b/i.test(n) ||
    (/\bcelular\b/i.test(n) && /\d+\s?gb/i.test(n))
  );
}

// Mesma ideia do fix de Smartphones: "notebook"/"laptop" no texto não
// significa que o produto É o notebook — pode ser mochila, case, suporte,
// cooler etc. feitos "para notebook".
function looksLikeNotebookAccessory(n) {
  return /(mochila|bolsa|maleta|mala|case\b|capa\b|suporte|cooler|refrigerador|almofada|skin|adesivo|luva|pel[ií]cula)[^.]*\b(notebook|laptop)\b|\b(notebook|laptop)\b[^.]*(mochila|bolsa|maleta|mala|case\b|capa\b|suporte|cooler)/i.test(n);
}

function isRealNotebookListing(n) {
  if (looksLikeNotebookAccessory(n)) return false;
  return /notebook|laptop|ultrabook|chromebook/i.test(n);
}

function inferTag(name) {
  const n = String(name || '').toLowerCase();

  // Pets — antes de Casa/Auto para não confundir "cama pet" com Casa, etc.
  // "ra[cç][aã]o" isolado bate como substring dentro de "duração"/"decoração";
  // por isso exige contexto (ração de/para cão, gato, cachorro, pet).
  if (/areia (sanit[aá]ria|para gato)|comedouro|fonte de [aá]gua.*pet|antipulga|coleira pet|petisco|\bpet\b|para c[aã]es|para gato|ra[cç][aã]o (de |para )?(c[aã]o|gato|cachorro|pet)/i.test(n)) return 'Pets';

  // Cabelo Liso (categoria OBRIGATÓRIA — ver mandatoryQuotas em bot-config.json).
  // Checada logo no começo, antes de Beleza/Eletrônicos, porque nomes como
  // "Escova Alisadora Smart" ou "Chapinha Bivolt" caem em regex mais amplas
  // (smart/bivolt/elétrico) se ficarem para depois. Cada termo é específico de
  // propósito para não capturar coisas como "lente progressiva", "prancha de
  // surf" ou "alisador de massa".
  if (
    /chapinha|prancha\s+(alisadora|de\s+cabelo|para\s+cabelo|profissional|cer[aâ]mica|titanium|bivolt|450|modeladora)|alisador(?!\s+(de\s+)?(massa|cimento|piso|concreto|parede|reboco))|alisante|alisamento|escova\s+(alisadora|secadora|modeladora|rotativa\s+secadora|el[eé]trica\s+alisadora)|pente\s+(alisador|el[eé]trico\s+alisador)|(kit|escova|creme|cabelo)\s+progressiva|progressiva\s+(sem|capilar|org[aâ]nica|para|de|kit)|selagem\s+(capilar|t[eé]rmica|de\s+cabelo)|kit\s+selagem|botox\s+capilar|cauteriza[cç][aã]o|cabelos?\s+lisos?|liso\s+obrigat[oó]rio|efeito\s+liso|liso\s+(espelhado|definitivo|perfeito)|ativador\s+de\s+liso|secador\s+(i[oô]nico|profissional)|protetor\s+t[eé]rmico/i.test(n)
  ) return 'Cabelo Liso';

  // Caixas de Som — categoria própria (antes ficavam misturadas em Eletrônicos e
  // quase não apareciam). Checada antes de Smartphones porque títulos como
  // "Caixa de Som para Smartphone" não são celular.
  if (/caixa\s+de\s+som|caixinha\s+de\s+som|soundbar|sound\s?bar|subwoofer|\bspeaker\b/i.test(n)) return 'Caixas de Som';

  // Smartphones — checado ANTES de Auto & Moto de propósito: "Motorola Moto
  // G84" tem "moto" no nome e seria capturado por engano como item de moto se
  // essa checagem viesse depois. IMPORTANTE: a palavra "celular"/"iphone"/
  // "samsung" sozinha NÃO basta — ela aparece o tempo todo em roupa/acessório
  // ("bolso para celular", "capinha iphone"), o que fazia short/legging/
  // capinha serem marcados como "Smartphones" e tomarem a vaga garantida de
  // celular de verdade. Só marca como Smartphones quando o texto tem cara de
  // ser O APARELHO em si (marca+modelo, "smartphone" isolado, ou "celular"
  // junto de capacidade em GB), e nunca quando é claramente roupa/acessório.
  if (isRealPhoneListing(n)) return 'Smartphones';

  // Auto & Moto
  if (/retrovisor|escapamento|moto\b|pneu|friso de roda|capa (para )?volante|automotiv|farol|para-choque|carburador/i.test(n)) return 'Auto & Moto';

  // Notebooks — separado de "Eletrônicos" (que hoje é dominado por acessórios
  // baratos); ter uma categoria própria é o que permite reservar vagas para
  // notebook de verdade no catálogo (ver categoryQuotas em bot-config.json).
  // MESMA lógica do fix de Smartphones: "notebook" sozinho no texto não basta
  // — "Mochila para Notebook", "Suporte para Notebook", "Cooler Notebook" são
  // ACESSÓRIO, não o notebook em si, e não podem tomar a vaga garantida.
  if (isRealNotebookListing(n)) return 'Notebooks';

  // Eletrodomésticos de linha branca — separado de "Cozinha" (que aqui é para
  // utensílios/miudezas). Mesma lógica: categoria própria = vaga garantida.
  if (/geladeira|refrigerador|fog[ãa]o\b|micro-?ondas|lavadora|m[aá]quina de lavar|freezer|adega climatizada|cooktop|depurador de ar|secadora de roupas/i.test(n)) return 'Eletrodomésticos';

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

  // Eletrônicos e acessórios de tecnologia (inclui capinha/película/case de
  // celular e mochila/case/suporte/cooler PARA notebook — chegam aqui porque
  // isRealPhoneListing()/isRealNotebookListing() já descartaram "ser o
  // aparelho em si" lá em cima; sem essa linha, esses itens ficavam sem
  // categoria nenhuma). Note: "mochila"/"case"/"suporte" sozinhos NÃO entram
  // aqui — só quando looksLikeNotebookAccessory() confirma que é
  // especificamente "para notebook/laptop" (senão mochila escolar/esportiva
  // qualquer virava "Eletrônicos" por engano).
  if (
    /fone|bluetooth|tws|watch|rel[oó]gio|nfc|smart|eletr[oô]nico|power ?bank|carregador|cabo usb|ring ?light|projetor|impressora|mouse|teclado|hub usb|drone|r[aá]dio comunicador|c[aâ]mera de seguran[cç]a|c[aâ]mera (wi-?fi|ip)|microfone|lapela|cart[aã]o de mem[oó]ria|pen ?drive|pendrive|\botg\b|\bssd\b|webcam|gamepad|joystick|tomada inteligente|ventilador (port[aá]til|de pesco[cç]o)|capinha|pel[ií]cula|capa (para|de) (celular|iphone|smartphone)|suporte (para|de) (celular|smartphone)/i.test(n) ||
    looksLikeNotebookAccessory(n)
  ) return 'Eletrônicos';

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

  // Escala logarítmica: recompensa preço baixo sem ZERAR itens de ticket maior
  // (smartphone, notebook, geladeira). Antes o coeficiente 9 zerava qualquer
  // item acima de ~R$774 — na prática isso fazia só acessório barato aparecer
  // no ranking. Agora usa coeficiente mais suave e piso de 4 pontos, e a
  // garantia de vaga por categoria (categoryQuotas) cobre o resto.
  const priceScore = price > 0 ? Math.max(4, 26 - Math.log10(price) * 7) : 10;
  const salesScore = Math.min(28, Math.log10(Math.max(1, sales)) * 6);
  const ratingScore = Math.min(24, rating * 4.8); // nota pesa mais: "produto de qualidade"

  // Desconto: teto bem mais alto que antes (era 12, agora 24) para promoção
  // relâmpago / super oferta pesar de verdade no ranking, não só um empurrãozinho.
  const discountScore = Math.min(24, discount / 1.5);
  // Bônus explícito de "achado excepcional" para descontos de nível
  // liquidação/relâmpago (>=40% e >=60%), somado ao discountScore acima.
  let flashBonus = 0;
  if (discount >= 60) flashBonus += 10;
  else if (discount >= 40) flashBonus += 5;

  // Comissão do afiliado: antes tinha teto de só 6 pontos (quase não pesava
  // no ranking). Agora pesa de verdade — produto com comissão extra para o
  // afiliado ganha prioridade real, não só um empurrãozinho simbólico.
  const commissionScore = Math.min(16, commission * 1.1);
  let commissionBonus = 0;
  if (commission >= 20) commissionBonus += 8;
  else if (commission >= 12) commissionBonus += 4;

  // Bônus de "excelente avaliação" (pedido explícito do usuário): nota alta
  // sozinha já pesa em ratingScore, mas aqui reforçamos ainda mais os melhores
  // avaliados (produto de qualidade de verdade, não só "acima da média").
  let ratingBonus = 0;
  if (rating >= 4.8) ratingBonus += 6;
  else if (rating >= 4.5) ratingBonus += 3;

  // Combo "barato + ótima nota" — exatamente o pedido do usuário: produto
  // barato com excelente avaliação ganha um empurrão extra além da soma das
  // partes, para aparecer na frente de itens caros com nota parecida.
  let cheapQualityBonus = 0;
  if (price > 0 && price <= 60 && rating >= 4.5) cheapQualityBonus += 4;

  // Combo "achado perfeito": barato + bem avaliado + comissão extra para o
  // afiliador, tudo junto — pedido explícito do usuário. É diferente dos
  // bônus isolados acima: só entra quando as TRÊS coisas se encontram no
  // mesmo produto, exatamente o tipo de item que compensa mais divulgar.
  let perfectFindBonus = 0;
  if (price > 0 && price <= 80 && rating >= 4.5 && commission >= 10) perfectFindBonus += 8;

  // Bônus pequeno para produtos ligados às sementes virais. A tendência nunca
  // supera o piso de preço/nota/loja, pois esses filtros acontecem antes do ranking.
  const normalizedTitle = normalizeDedupeText(p.productName);
  const viralKeywords = Array.isArray(config?.viralKeywords) ? config.viralKeywords : [];
  const viralHit = viralKeywords.some((keyword) => {
    const normalizedKeyword = normalizeDedupeText(keyword);
    return normalizedKeyword && normalizedTitle.includes(normalizedKeyword);
  });
  const viralBonus = viralHit ? Math.max(0, toNumber(config?.viralBonus, 10)) : 0;

  // Reforço para categorias de maior crescimento projetado até 2027
  // (bot-config.json > trendingCategoryBoost), sem excluir as demais.
  const boostMap = { ...(config?.trendingCategoryBoost || {}), ...(config?.viralCategoriesBoost || {}) };
  const categoryBoost = toNumber(boostMap[inferTag(p.productName)], 0);

  // Comissão esperada por venda (R$ = preço x comissão): um produto de R$ 300
  // com 8% paga bem mais por venda que um de R$ 15 com 10%. Teto baixo (10) para
  // NÃO passar por cima de nota/vendas — qualidade continua mandando.
  // "Super bem avaliado E muito vendido": nota 4,9+ com 500+ vendas.
  const superRatedBonus = rating >= 4.9 && sales >= 500 ? 8 : (rating >= 4.8 && sales >= 200 ? 4 : 0);
  // Ótimo desconto COM prova de qualidade (nota alta + vendas): é o "achado" de custo-benefício.
  const dealBonus = discount >= 40 && rating >= 4.7 && sales >= 100 ? 8 : (discount >= 25 && rating >= 4.7 && sales >= 100 ? 3 : 0);
  const expectedCommission = price > 0 ? (price * commission) / 100 : 0;
  const expectedCommissionScore = Math.min(4, Math.log10(1 + expectedCommission) * 3);

  return priceScore + salesScore + ratingScore + discountScore + flashBonus +
    commissionScore + commissionBonus + ratingBonus + cheapQualityBonus +
    perfectFindBonus + viralBonus + categoryBoost + expectedCommissionScore +
    superRatedBonus + dealBonus;
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
    shopType: normalizedShopTypes(product.shopType),
    marketplace: 'BR',
    itemId: String(product.itemId),
    productLink: product.productLink || '',
    affLink: affiliateLink || product.offerLink || '',
    category1: inferTag(product.productName),
    category2: '',
    category3: '',
    updatedAt: new Date().toISOString()
  };
}

function fixedAsFallback(fixed, config = {}) {
  // Fallback também respeita o piso de R$10 e bloqueia lojas com nome claramente
  // internacional. A avaliação, quando ausente no seed fixo, não é inventada.
  return fixed
    .filter((p) => !!p.offerLink)
    .filter((p) => parsePrice(p?.price) >= Number(config.minPrice || 10))
    .filter((p) => {
      const name = p?.shopName || '';
      return !shopNameLooksInternational(name, config);
    })
    .map((p) => ({
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
    affLink: p.offerLink,
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
  const rotation = Array.isArray(config.sortTypeRotation) && config.sortTypeRotation.length
    ? config.sortTypeRotation
    : SORT_TYPE_ROTATION;
  return rotation[runCount % rotation.length];
}

// Além de girar o sortType a cada execução, também giramos a PÁGINA inicial
// de cada keyword (1, 2, 3, 1, 2, 3…). Sem isso, com pagesPerKeyword=1 o bot
// sempre pedia a página 1 — que a Shopee devolve praticamente idêntica de
// execução em execução para o mesmo sortType, sendo a maior causa de produto
// repetido. Girando sortType (4 valores) x página (3 valores) = 12 execuções
// (~6h) de combinações diferentes por keyword antes de repetir a mesma busca.
function pickPageStart(config, runCount) {
  const span = Math.max(1, config.pageRotationSpan || 3);
  return 1 + (runCount % span);
}

async function searchKeyword(keyword, config, runCount) {
  const results = [];
  const pages = Math.max(1, Math.min(config.pagesPerKeyword || 1, 5));
  const limit = Math.max(1, Math.min(config.limitPerQuery || 50, 500));
  const sortType = pickSortType(config, runCount);
  const pageStart = pickPageStart(config, runCount);
  for (let i = 0; i < pages; i++) {
    const page = pageStart + i;
    // retries menor aqui (é chamado 200+ vezes por rodada): o objetivo é
    // absorver picos passageiros de erro 10000/10030 sem estourar o tempo
    // total de execução do workflow.
    const data = await withRateLimitRetry(
      () => graphql(buildSearchQuery({ keyword, sortType, page, limit })),
      { retries: 2, baseDelayMs: 900 }
    );
    const connection = data?.productOfferV2;
    results.push(...(connection?.nodes || []));
    if (!connection?.pageInfo?.hasNextPage) break;
  }
  return results;
}

async function topPerforming(config) {
  const limit = Math.max(1, Math.min(config.topPerformingLimit || 50, 100));
  try {
    const data = await withRateLimitRetry(() => graphql(buildTopQuery({ page: 1, limit, includeSortType: true })));
    return data?.productOfferV2?.nodes || [];
  } catch (error) {
    if (error?.code === 11001) {
      console.warn('  ↻ top-performing: Shopee recusou com sortType, tentando de novo sem sortType…');
      const data = await withRateLimitRetry(() => graphql(buildTopQuery({ page: 1, limit, includeSortType: false })));
      return data?.productOfferV2?.nodes || [];
    }
    throw error;
  }
}

// Atraso pequeno entre chamadas sequenciais à API da Shopee, só para não estourar
// o limite de requisições (erro 10030) quando o bot passa por várias keywords.
// Espaçamento entre chamadas à Shopee para reduzir a chance de rate limit /
// erro interno [10000] logo na primeira tentativa (861 keywords + retries +
// segunda passada já bastam para variedade; não vale a pena arriscar mais
// falhas só para ganhar alguns segundos de execução).
const API_CALL_DELAY_MS = 450;

async function collectDynamicProducts(config, diagnostics, runCount) {
  const map = new Map();
  const allKeywords = Array.isArray(config.keywords) ? config.keywords : [];
  const failedKeywords = [];

  // Com a lista de keywords tendo crescido bastante (centenas de termos, para
  // cobrir muito mais tipos de produto), rodar TODAS numa execução só
  // estouraria o tempo do workflow. Em vez disso, cada execução varre um
  // "lote" (batch) diferente da lista inteira, girando pelo runCount — ao
  // longo de poucas execuções (algumas horas), todos os termos são
  // pesquisados, sem nunca remover nenhum da lista.
  const batchSize = Math.max(20, config.keywordBatchSize || allKeywords.length);
  const numBatches = Math.max(1, Math.ceil(allKeywords.length / batchSize));
  const batchIndex = runCount % numBatches;
  const start = batchIndex * batchSize;
  const keywords = allKeywords.slice(start, start + batchSize);
  diagnostics.keywordBatch = { index: batchIndex, of: numBatches, size: keywords.length, totalKeywords: allKeywords.length };
  console.log(`  🧭 Lote de keywords ${batchIndex + 1}/${numBatches} (${keywords.length} de ${allKeywords.length} termos no total)`);

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
      failedKeywords.push(keyword);
    }
    await sleep(API_CALL_DELAY_MS);
  }

  // Segunda passada só nas keywords que falharam: erros [10000]/[10030] da
  // Shopee costumam ser passageiros, e por essa altura (minutos depois da
  // primeira tentativa) a instabilidade normalmente já se resolveu sozinha.
  // Isso evita perder dezenas de palavras-chave inteiras por rodada — e é
  // justamente esse buraco no pool de candidatos que forçava o bot a
  // completar o catálogo com itens repetidos do ciclo anterior.
  if (failedKeywords.length > 0) {
    console.log(`\n🔁 Segunda tentativa para ${failedKeywords.length} keyword(s) que falharam…`);
    for (const keyword of failedKeywords) {
      try {
        const nodes = await searchKeyword(keyword, config, runCount);
        console.log(`  ✓ (2ª tentativa) ${keyword}: ${nodes.length} produtos encontrados`);
        diagnostics.keywordCounts[keyword] = nodes.length;
        for (const node of nodes) {
          const id = String(node.itemId || '');
          if (id) map.set(id, node);
        }
      } catch (error) {
        const hint = explainShopeeError(error);
        console.warn(`  ⚠ (2ª tentativa) ${keyword}: ${hint}`);
      }
      await sleep(API_CALL_DELAY_MS);
    }
  }

  // Coleta complementar de produtos virais em TODAS as rodadas. Não é um
  // ranking oficial do TikTok; são termos de tendência usados como sementes de
  // descoberta e os resultados ainda precisam passar pelas regras de qualidade.
  try {
    const viralNodes = await collectViralProducts(config, diagnostics);
    for (const node of viralNodes) {
      const id = String(node.itemId || '');
      if (id) map.set(id, node);
    }
  } catch (error) {
    diagnostics.errors.push(`viral: ${explainShopeeError(error)}`);
  }

  // Coleta OBRIGATÓRIA de produtos de cabelo liso, em TODAS as rodadas.
  try {
    const mandatoryNodes = await collectMandatoryProducts(config, diagnostics, runCount);
    console.log(`  ✓ cabelo liso (obrigatório): ${mandatoryNodes.length} candidatos`);
    for (const node of mandatoryNodes) {
      const id = String(node.itemId || '');
      if (id) map.set(id, node);
    }
  } catch (error) {
    diagnostics.errors.push(`mandatory: ${explainShopeeError(error)}`);
  }

  // Produtos de ticket mais alto (celular, notebook, TV, eletrodoméstico...) — em rodízio.
  try {
    const premiumNodes = await collectPremiumProducts(config, diagnostics, runCount);
    console.log(`  ✓ ticket alto (premium): ${premiumNodes.length} candidatos`);
    for (const node of premiumNodes) {
      const id = String(node.itemId || '');
      if (id) map.set(id, node);
    }
  } catch (error) {
    diagnostics.errors.push(`premium: ${explainShopeeError(error)}`);
  }

  // Produtos FIXADOS (ex.: kit Belkit Liso Obrigatório) — sempre buscados.
  try {
    const pinnedNodes = await collectPinnedProducts(config, diagnostics);
    for (const node of pinnedNodes) map.set(String(node.itemId), node);
    if (pinnedNodes.length) console.log(`  📌 produtos fixados encontrados: ${pinnedNodes.length}`);
  } catch (error) {
    diagnostics.errors.push(`pinned: ${explainShopeeError(error)}`);
  }

  // Coleta complementar de alta comissão em TODAS as rodadas, independente
  // do sortType rotativo principal. O resultado ainda passa por qualidade,
  // deduplicação e pelo limite máximo de participação de comissão no catálogo.
  try {
    const highCommissionNodes = await collectHighCommissionProducts(config, diagnostics, runCount);
    for (const node of highCommissionNodes) {
      const id = String(node.itemId || '');
      if (id) map.set(id, node);
    }
  } catch (error) {
    diagnostics.errors.push(`high-commission: ${explainShopeeError(error)}`);
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


async function collectViralProducts(config, diagnostics) {
  const all = Array.isArray(config?.viralKeywords) ? config.viralKeywords.filter(Boolean) : [];
  const count = Math.max(1, Math.min(Number(config?.viralKeywordsPerRun || 28), all.length || 1));
  const offset = Number(diagnostics?.runCount || 0) % Math.max(1, all.length);
  const keywords = all.length ? Array.from({ length: Math.min(count, all.length) }, (_, i) => all[(offset + i) % all.length]) : [];
  const limit = Math.max(1, Math.min(Number(config?.viralLimitPerKeyword || 50), 50));
  const nodes = [];
  diagnostics.viralQueries = 0;
  diagnostics.viralCandidates = 0;
  for (const keyword of keywords) {
    try {
      const data = await withRateLimitRetry(
        () => graphql(buildSearchQuery({ keyword, sortType: 2, page: 1, limit })),
        { retries: 2, baseDelayMs: 900 }
      );
      const found = data?.productOfferV2?.nodes || [];
      diagnostics.viralQueries++;
      diagnostics.viralCandidates += found.length;
      nodes.push(...found);
    } catch (error) {
      diagnostics.errors.push(`viral "${keyword}": ${explainShopeeError(error)}`);
    }
    await sleep(API_CALL_DELAY_MS);
  }
  return nodes;
}


// Coleta OBRIGATÓRIA (cabelo liso / alisamento). Roda em TODA execução, fora da
// rotação por lote das 861 keywords, para que a categoria nunca fique sem
// candidatos. Gira as keywords e as páginas entre execuções, como o restante do
// bot, para trazer produtos diferentes a cada ciclo (cooldown continua valendo).
async function collectMandatoryProducts(config, diagnostics, runCount) {
  const all = Array.isArray(config?.mandatoryKeywords) ? config.mandatoryKeywords.filter(Boolean) : [];
  diagnostics.mandatoryQueries = 0;
  diagnostics.mandatoryCandidates = 0;
  if (!all.length) return [];
  const count = Math.max(1, Math.min(Number(config?.mandatoryKeywordsPerRun || 24), all.length));
  const offset = (Number(runCount || 0) * count) % all.length;
  const keywords = Array.from({ length: count }, (_, i) => all[(offset + i) % all.length]);
  const pages = Math.max(1, Math.min(Number(config?.mandatoryPages || 2), 4));
  const limit = Math.max(1, Math.min(Number(config?.mandatoryLimitPerKeyword || 50), 50));
  const sortType = pickSortType(config, runCount);
  const pageStart = pickPageStart(config, runCount);
  const nodes = [];
  for (const keyword of keywords) {
    for (let i = 0; i < pages; i++) {
      try {
        const data = await withRateLimitRetry(
          () => graphql(buildSearchQuery({ keyword, sortType, page: pageStart + i, limit })),
          { retries: 2, baseDelayMs: 900 }
        );
        const connection = data?.productOfferV2;
        const found = connection?.nodes || [];
        diagnostics.mandatoryQueries++;
        diagnostics.mandatoryCandidates += found.length;
        nodes.push(...found);
        if (!connection?.pageInfo?.hasNextPage) break;
      } catch (error) {
        diagnostics.errors.push(`mandatory "${keyword}": ${explainShopeeError(error)}`);
        break;
      }
      await sleep(API_CALL_DELAY_MS);
    }
    await sleep(API_CALL_DELAY_MS);
  }
  return nodes;
}


// PRODUTOS FIXADOS (pinnedProducts em bot-config.json): entram em TODA rodada, em
// primeiro lugar, ignorando o cooldown anti-repetição — são escolhas do dono do
// site. Continuam passando nos filtros de preço/nota/loja e usam SEMPRE o link
// de afiliado devolvido pela API da sua conta. Ordem de busca: (1) direto por
// itemId; (2) por nome, aceitando só o MESMO itemId quando ele foi informado, ou
// o melhor casamento de título quando não foi.
const normText = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

async function collectPinnedProducts(config, diagnostics) {
  const pins = Array.isArray(config?.pinnedProducts) ? config.pinnedProducts : [];
  diagnostics.pinned = [];
  const found = [];
  for (const pin of pins) {
    const label = String(pin?.name || pin?.itemId || 'produto fixado').slice(0, 100);
    const wantId = /^\d+$/.test(String(pin?.itemId || '')) ? String(pin.itemId) : '';
    const wantShop = /^\d+$/.test(String(pin?.shopId || '')) ? String(pin.shopId) : '';
    let node = null;
    let via = '';

    if (wantId) {
      try {
        const data = await withRateLimitRetry(
          () => graphql(buildItemQuery({ itemId: wantId, shopId: wantShop })),
          { retries: 2, baseDelayMs: 900 }
        );
        node = (data?.productOfferV2?.nodes || []).find((n) => String(n?.itemId) === wantId) || null;
        if (node) via = 'itemId';
      } catch (error) {
        diagnostics.errors.push(`pinned itemId ${wantId}: ${explainShopeeError(error)}`);
      }
      await sleep(API_CALL_DELAY_MS);
    }

    if (!node) {
      const must = (pin?.mustInclude || []).map(normText);
      const should = (pin?.shouldInclude || []).map(normText);
      for (const query of pin?.queries || []) {
        try {
          const data = await withRateLimitRetry(
            () => graphql(buildSearchQuery({ keyword: query, sortType: 1, page: 1, limit: 50 })),
            { retries: 2, baseDelayMs: 900 }
          );
          const nodes = data?.productOfferV2?.nodes || [];
          if (wantId) {
            node = nodes.find((n) => String(n?.itemId) === wantId) || null;
          } else {
            let best = null;
            let bestScore = -1;
            for (const n of nodes) {
              const title = normText(n?.productName);
              if (!must.every((m) => title.includes(m))) continue;
              const score = should.filter((w) => title.includes(w)).length * 10 + Math.log10(1 + Number(n?.sales || 0));
              if (score > bestScore) { best = n; bestScore = score; }
            }
            node = best;
          }
          if (node) { via = `busca "${query}"`; break; }
        } catch (error) {
          diagnostics.errors.push(`pinned "${query}": ${explainShopeeError(error)}`);
        }
        await sleep(API_CALL_DELAY_MS);
      }
    }

    diagnostics.pinned.push({ name: label, found: !!node, via: via || null });
    if (node) found.push({ ...node, __pinned: true });
    else console.warn(`⚠️ Produto fixado NÃO encontrado pela API de afiliados: ${label}`);
  }
  return found;
}

// Coleta de produtos de TICKET MAIS ALTO (premiumKeywords em bot-config.json):
// celular, notebook, TV, eletrodoméstico, games etc. Ordena por VENDAS (sortType 2)
// ou relevância (1), nunca por preço, para trazer o que realmente vende. O portão
// de qualidade por faixa de preço (qualityByPriceTier) decide quem entra depois.
async function collectPremiumProducts(config, diagnostics, runCount) {
  const all = Array.isArray(config?.premiumKeywords) ? config.premiumKeywords.filter(Boolean) : [];
  diagnostics.premiumQueries = 0;
  diagnostics.premiumCandidates = 0;
  if (!all.length) return [];
  const count = Math.max(1, Math.min(Number(config?.premiumKeywordsPerRun || 40), all.length));
  const offset = (Number(runCount || 0) * count) % all.length;
  const keywords = Array.from({ length: count }, (_, i) => all[(offset + i) % all.length]);
  const pages = Math.max(1, Math.min(Number(config?.premiumPages || 2), 3));
  const limit = Math.max(1, Math.min(Number(config?.premiumLimitPerKeyword || 50), 50));
  const sortType = Number(runCount || 0) % 2 === 0 ? 2 : 1;
  const pageStart = pickPageStart(config, runCount);
  const nodes = [];
  for (const keyword of keywords) {
    for (let i = 0; i < pages; i++) {
      try {
        const data = await withRateLimitRetry(
          () => graphql(buildSearchQuery({ keyword, sortType, page: pageStart + i, limit })),
          { retries: 2, baseDelayMs: 900 }
        );
        const connection = data?.productOfferV2;
        const found = connection?.nodes || [];
        diagnostics.premiumQueries++;
        diagnostics.premiumCandidates += found.length;
        nodes.push(...found);
        if (!connection?.pageInfo?.hasNextPage) break;
      } catch (error) {
        diagnostics.errors.push(`premium "${keyword}": ${explainShopeeError(error)}`);
        break;
      }
      await sleep(API_CALL_DELAY_MS);
    }
    await sleep(API_CALL_DELAY_MS);
  }
  return nodes;
}

async function collectHighCommissionProducts(config, diagnostics, runCount = 0) {
  const allKeywords = Array.isArray(config.highCommissionKeywords) && config.highCommissionKeywords.length
    ? config.highCommissionKeywords.filter(Boolean)
    : ['ofertas', 'promocao', 'moda', 'beleza', 'casa', 'cozinha', 'eletronicos', 'fitness'];
  // Rodízio: highCommissionKeywordsPerRun termos por execução (padrão 10, como antes).
  const perRun = Math.max(1, Math.min(Number(config.highCommissionKeywordsPerRun || 10), allKeywords.length));
  const offset = (Number(runCount || 0) * perRun) % allKeywords.length;
  const keywords = Array.from({ length: perRun }, (_, i) => allKeywords[(offset + i) % allKeywords.length]);
  const pages = Math.max(1, Math.min(Number(config.highCommissionPages || 1), 3));
  const limit = Math.max(1, Math.min(config.highCommissionLimitPerKeyword || 30, 100));
  const nodes = [];
  diagnostics.highCommissionQueries = 0;
  diagnostics.highCommissionCandidates = 0;

  // listType 1 prioriza ofertas com maior comissão; sortType 5 também ordena
  // por comissão. É uma coleta pequena e separada para que uma rodada cujo
  // sortType principal seja vendas/preço ainda tenha acesso a boas ofertas de
  // afiliado.
  for (const keyword of keywords) {
    for (let page = 1; page <= pages; page++) {
      try {
        const data = await withRateLimitRetry(
          () => graphql(buildSearchQuery({
            keyword,
            sortType: 5,
            page,
            limit,
            listType: 1
          })),
          { retries: 2, baseDelayMs: 900 }
        );
        const connection = data?.productOfferV2;
        const found = connection?.nodes || [];
        diagnostics.highCommissionQueries++;
        diagnostics.highCommissionCandidates += found.length;
        nodes.push(...found);
        if (!connection?.pageInfo?.hasNextPage) break;
      } catch (error) {
        diagnostics.errors.push(`high-commission "${keyword}": ${explainShopeeError(error)}`);
        break;
      }
      await sleep(API_CALL_DELAY_MS);
    }
    await sleep(API_CALL_DELAY_MS);
  }

  return nodes;
}

// ===== Controle de itens equivalentes / repetidos =====
// A Shopee pode devolver o mesmo item por lojas diferentes. O itemId resolve
// repetições exatas, mas não resolve o caso em que duas lojas usam títulos
// diferentes. Aqui criamos uma assinatura textual conservadora e, quando duas
// ofertas aparentam representar o mesmo produto, mantemos somente a mais barata.
// Assim o catálogo continua focado em "um item = uma oportunidade", sem apagar
// produtos apenas parecidos.
//
// Observação: isto é uma heurística de catálogo, não uma identificação por SKU.
// Para não confundir variações reais (ex.: cabo 1m vs 2m), números e medidas
// continuam fazendo parte da assinatura.
const DEDUPE_STOPWORDS = new Set([
  'a','o','as','os','um','uma','uns','umas','de','da','do','das','dos','em','no','na',
  'nos','nas','e','ou','para','por','com','sem','ao','aos','à','às','se','que','mais',
  'novo','nova','novos','novas','super','promoção','promocao','oferta','ofertas',
  'barato','barata','baratos','baratas','original','originais','premium','melhor',
  'melhores','frete','envio','imediato','imediata','atacado','varejo','revenda',
  'unidade','unidades','pc','pcs','peça','peca','peças','pecas','kit'
]);

function normalizeDedupeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dedupeTokens(value) {
  const tokens = normalizeDedupeText(value)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !DEDUPE_STOPWORDS.has(token))
    .filter((token) => token.length >= 2 || /^\d+(?:[a-z]+)?$/.test(token));

  // Mantém uma ocorrência de cada token. Ordenar deixa "A + B + C" equivalente
  // a "C + A + B" quando a loja apenas reorganiza o título.
  return [...new Set(tokens)].sort();
}

function productTitleOf(product) {
  return product?.productName || product?.itemName || product?.title || '';
}

function productIdentityKey(product) {
  const tokens = dedupeTokens(productTitleOf(product));
  return tokens.slice(0, 18).join('|');
}

function tokenSimilarity(a, b) {
  const aa = new Set(dedupeTokens(a));
  const bb = new Set(dedupeTokens(b));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;
  return common / Math.max(1, Math.min(aa.size, bb.size));
}

function numericTokens(value) {
  return dedupeTokens(value).filter((token) => /^\d+(?:[a-z]+)?$/.test(token));
}

function numericMismatch(a, b) {
  const aa = numericTokens(a);
  const bb = numericTokens(b);
  if (!aa.length || !bb.length) {
    // Um título sem número e outro com "1 unidade" ainda pode ser a mesma oferta.
    // Para números >1 (quantidade, capacidade, medida etc.), preferimos não unir
    // sem evidência no outro título.
    const only = aa.length ? aa : bb;
    return only.some((token) => {
      const number = Number.parseInt(token, 10);
      return Number.isFinite(number) && number > 1;
    });
  }
  return !aa.some((token) => bb.includes(token));
}

function dedupeEquivalentProducts(products, diagnostics) {
  const exactByKey = new Map();
  const buckets = new Map();
  const kept = [];
  let droppedExact = 0;
  let droppedEquivalent = 0;

  const priceOf = (p) => toNumber(p?.priceMin || p?.priceMax);

  for (const p of products) {
    const id = String(p?.itemId || '');
    if (!id) continue;

    // 1) Mesmo itemId: nunca duplica, independente da loja.
    if (exactByKey.has(id)) {
      droppedExact++;
      const existingIndex = exactByKey.get(id);
      const existing = kept[existingIndex];
      if (priceOf(p) > 0 && (priceOf(existing) <= 0 || priceOf(p) < priceOf(existing))) {
        kept[existingIndex] = p;
      }
      continue;
    }

    const key = productIdentityKey(p);

    // Títulos muito curtos/genéricos não são bons para deduplicação semântica.
    if (key.split('|').length >= 4) {
      const bucketTokens = key.split('|').filter((token) => !/^\d+(?:[a-z]+)?$/.test(token));
      const firstTokens = bucketTokens.slice(0, 2);
      const bucketKey = firstTokens.join('|') || key;
      const indexes = buckets.get(bucketKey) || [];

      let equivalentIndex = -1;
      for (const idx of indexes) {
        const candidate = kept[idx];
        if (!candidate) continue;

        // O preço zero não serve para decidir qual loja vence.
        // Nesse caso, mantemos a primeira oferta equivalente já encontrada.
        const titlesMismatch = numericMismatch(productTitleOf(p), productTitleOf(candidate));
        const similarity = tokenSimilarity(productTitleOf(p), productTitleOf(candidate));
        if (!titlesMismatch && (similarity >= 0.80 || key === productIdentityKey(candidate))) {
          equivalentIndex = idx;
          break;
        }
      }

      if (equivalentIndex >= 0) {
        const existing = kept[equivalentIndex];
        const currentPrice = priceOf(p);
        const existingPrice = priceOf(existing);

        // Regra pedida: entre lojas diferentes, só deixa entrar a oferta
        // equivalente quando ela é realmente mais barata. Se o preço não puder
        // ser comparado, mantemos a primeira oferta em vez de inventar vantagem.
        if (currentPrice > 0 && (existingPrice <= 0 || currentPrice < existingPrice)) {
          kept[equivalentIndex] = p;
        }
        droppedEquivalent++;
        continue;
      }

      indexes.push(kept.length);
      buckets.set(bucketKey, indexes);
    }

    exactByKey.set(id, kept.length);
    kept.push(p);
  }

  if (diagnostics) {
    diagnostics.duplicatesDroppedExact = droppedExact;
    diagnostics.duplicatesComparedAcrossStores = droppedEquivalent;
    diagnostics.uniqueCandidatesAfterDedupe = kept.length;
  }

  return kept;
}

// Regras de entrada do catálogo: preço mínimo, avaliação e loja elegível.
// A prioridade é qualidade + preço real do produto, não apenas comissão.
const MIN_PRICE = 10;
const MIN_RATING = 4.5;

function passesQualityBar(p, config, opts = {}) {
  const minPrice = Math.max(0, toNumber(config?.minPrice ?? MIN_PRICE));
  const price = catalogMinPrice(p);
  if (!(price >= minPrice)) return false;

  // TETO de preço (bot-config.json > maxPrice): foco em custo-benefício. Nenhuma
  // variação do anúncio pode passar do teto (evita anúncio "de R$ 800 a R$ 6.000").
  const maxPrice = toNumber(config?.maxPrice ?? 0);
  if (maxPrice > 0 && (price > maxPrice || toNumber(p.priceMax) > maxPrice)) return false;

  // Piso por categoria (tagMinPrice): "Smartphone" a R$ 60 é golpe/brinquedo, não celular.
  const tagFloor = toNumber(config?.tagMinPrice?.[inferTag(p.productName)] ?? 0);
  if (tagFloor > 0 && price < tagFloor) return false;

  const rating = ratingNumber(p.ratingStar);
  const minRating = toNumber(config?.minRating ?? MIN_RATING);
  if (config?.requireRating !== false && !(rating > 0)) return false;
  if (rating > 0 && rating < minRating) return false;

  if (!isBrazilMarketplaceOffer(p, config)) return false;

  // Faixas de preço mais altas exigem PROVA de qualidade: mais vendas e nota
  // maior (bot-config.json > qualityByPriceTier). Item caro sem histórico de
  // venda não entra, por mais comissão que pague.
  const sales = toNumber(p.sales);
  for (const tier of opts.pinned ? [] : Array.isArray(config?.qualityByPriceTier) ? config.qualityByPriceTier : []) {
    const min = toNumber(tier.min);
    const max = tier.max == null ? Infinity : toNumber(tier.max);
    if (price >= min && price < max) {
      if (tier.minRating && rating < toNumber(tier.minRating)) return false;
      if (tier.minSales && sales < toNumber(tier.minSales)) return false;
      break;
    }
  }

  // Comissão alta (20%+) muitas vezes é "isca" de vendedor com produto sem
  // histórico. Exige um mínimo de vendas e nota para entrar.
  if (!opts.pinned && commissionPct(p.commissionRate) >= 20) {
    if (rating < toNumber(config?.highCommissionMinRating ?? 0)) return false;
    if (sales < toNumber(config?.highCommissionMinSales ?? 0)) return false;
  }
  return true;
}

// Um produto só conta como "esgotado" (fora do pool fresco) se foi publicado
// há menos de `cooldownRuns` execuções. Diferente de comparar só com o ciclo
// anterior, isso olha o HISTÓRICO real (product-history.json, persistido
// entre execuções), então um produto publicado no ciclo 1 não pode voltar
// "como se fosse novo" no ciclo 3 só porque sumiu do ciclo 2.
function isFreshEnough(itemId, history, runCount, cooldownRuns) {
  const entry = history[String(itemId)];
  if (!entry || !Number.isFinite(entry.lastRun)) return true;
  return runCount - entry.lastRun >= cooldownRuns;
}

async function buildDynamicCatalog(nodes, config, diagnostics, history, runCount) {
  const target = Math.max(1, config.maxProducts || 50);
  const cooldownRuns = Math.max(0, config.repeatCooldownRuns ?? 4);
  const beforeFilter = nodes.length;
  const filtered = nodes.filter((p) => p && p.itemId && p.productLink && p.imageUrl);
  const qualityFiltered = filtered.filter((p) => passesQualityBar(p, config));
  diagnostics.candidatesRaw = beforeFilter;
  diagnostics.candidatesAfterFilter = filtered.length;
  diagnostics.candidatesDroppedMissingFields = beforeFilter - filtered.length;
  diagnostics.candidatesDroppedLowRating = filtered.length - qualityFiltered.length;

  const uniqueQualityFiltered = dedupeEquivalentProducts(qualityFiltered, diagnostics);

  const ranked = uniqueQualityFiltered
    .map((p) => ({
      p,
      score: scoreProduct(p, config),
      isFresh: isFreshEnough(p.itemId, history, runCount, cooldownRuns)
    }))
    .sort((a, b) => b.score - a.score);

  // Regra atual: nunca usar um item que ainda esteja dentro do cooldown.
  // Se não houver variedade suficiente, o catálogo fica menor em vez de
  // reapresentar produtos antigos.
  const freshAll = ranked.filter((r) => r.isFresh);
  const fresh = freshAll.slice(0, target * 6);
  // Itens de ticket alto pontuam menos no preço e poderiam ficar fora do corte
  // acima: reinclui os melhores deles (R$ 60+) para as cotas por faixa enxergarem.
  fresh.push(...freshAll.slice(target * 6).filter((r) => catalogMinPrice(r.p) >= 60).slice(0, target * 2));
  const repeatable = ranked.filter((r) => !r.isFresh).slice(0, target * 2);
  diagnostics.freshCandidates = fresh.length;
  diagnostics.repeatableCandidates = repeatable.length;
  diagnostics.cooldownRuns = cooldownRuns;

  const results = [];
  const usedIds = new Set();
  const selectedMeta = new Map(); // id -> { price, tag, ctier } do que já entrou
  let linkFailures = 0;

  function commissionTier(p) {
    const rate = commissionPct(p?.commissionRate);
    if (rate >= 30) return '30+';
    if (rate >= 20) return '20-29.99';
    if (rate >= 10) return '10-19.99';
    return '';
  }

  // "Ótimo desconto" com prova de qualidade (bot-config.json > dealQuota).
  const dealCfg = config.dealQuota || {};
  function isGreatDeal(p) {
    if (!dealCfg || !toNumber(dealCfg.quota)) return false;
    return toNumber(p?.priceDiscountRate) >= toNumber(dealCfg.minDiscount ?? 40) &&
      ratingNumber(p?.ratingStar) >= toNumber(dealCfg.minRating ?? 4.7) &&
      toNumber(p?.sales) >= toNumber(dealCfg.minSales ?? 50);
  }

  function isHighCommission(p) {
    return commissionPct(p?.commissionRate) >= 10;
  }

  const commissionQuotas = config.commissionQuotas || {
    '10-19.99': 75,
    '20-29.99': 20,
    '30+': 5
  };
  const maxCommissionShare = Math.min(
    1,
    Math.max(0, toNumber(config.maxCommissionShare, 0.25))
  );
  const maxHighCommission = Math.floor(target * maxCommissionShare);
  diagnostics.commissionQuotaTarget = commissionQuotas;
  diagnostics.maxCommissionShare = maxCommissionShare;
  diagnostics.maxHighCommissionProducts = maxHighCommission;
  diagnostics.commissionQuotaFilled = {};

  let selectedHighCommission = 0;

  // LIMITE MÁXIMO por faixa de preço (bot-config.json > priceCaps). As cotas de
  // priceTierQuotas são MÍNIMOS; estes são TETOS de quantidade: o site é de
  // produto barato, então itens de R$ 100+ / R$ 300+ entram só em quantidade moderada.
  const priceCaps = (Array.isArray(config.priceCaps) ? config.priceCaps : [])
    .map((c) => ({ min: toNumber(c.min), max: Math.floor(toNumber(c.maxShare) * target), label: String(c.label || `R$ ${c.min}+`) }))
    .filter((c) => c.min > 0 && c.max >= 0);
  diagnostics.priceCapMax = Object.fromEntries(priceCaps.map((c) => [c.label, c.max]));

  async function tryAddProduct(p, { enforceCommissionCap = true } = {}) {
    const id = String(p.itemId);
    if (usedIds.has(id)) return false;
    {
      const price = catalogMinPrice(p);
      for (const cap of priceCaps) {
        if (price < cap.min) continue;
        let count = 0;
        for (const m of selectedMeta.values()) if (m.price >= cap.min) count++;
        if (count >= cap.max) return false;
      }
    }
    if (enforceCommissionCap && isHighCommission(p) && selectedHighCommission >= maxHighCommission) {
      return false;
    }

    const affiliateLink = await generateAffiliateLink(p, config);
    if (!affiliateLink) {
      linkFailures++;
      return false;
    }

    usedIds.add(id);
    results.push(normalizeProduct(p, affiliateLink));
    selectedMeta.set(id, { price: catalogMinPrice(p), tag: inferTag(p.productName), ctier: commissionTier(p), deal: isGreatDeal(p) });
    if (isHighCommission(p)) selectedHighCommission++;
    return true;
  }

  // Produtos FIXADOS: entram primeiro e ignoram o cooldown (mas não os filtros
  // de qualidade). O motivo de algum não entrar fica em diagnostics.pinnedResult.
  diagnostics.pinnedResult = [];
  for (const p of nodes.filter((n) => n && n.__pinned)) {
    const name = String(p.productName || p.itemId).slice(0, 100);
    if (!p.itemId || !p.productLink || !p.imageUrl) { diagnostics.pinnedResult.push({ name, published: false, reason: 'faltam campos (link/imagem)' }); continue; }
    // Fixado é escolha do dono: vale piso/teto de preço, nota mínima e loja do Brasil; não exige o mínimo de vendas por faixa.
    if (!passesQualityBar(p, config, { pinned: true })) { diagnostics.pinnedResult.push({ name, published: false, reason: 'não passou nos filtros (preço entre R$ 10 e R$ 1.000, nota mínima ou tipo de loja)' }); continue; }
    const ok = await tryAddProduct(p, { enforceCommissionCap: false });
    if (ok) results[results.length - 1].pinned = true;
    diagnostics.pinnedResult.push({ name, published: ok, reason: ok ? 'ok' : 'sem link de afiliado' });
  }

  // Categorias OBRIGATÓRIAS (mandatoryQuotas em bot-config.json, ex.: "Cabelo Liso").
  // Preenchidas antes de tudo: o produto ainda precisa passar em preço, nota,
  // loja, link afiliado e estar fora do cooldown, mas a vaga é reservada.
  const mandatoryQuotas = config.mandatoryQuotas || {};
  diagnostics.mandatoryQuotaTarget = mandatoryQuotas;
  diagnostics.mandatoryQuotaFilled = {};
  for (const category of Object.keys(mandatoryQuotas)) {
    const quota = Math.min(toNumber(mandatoryQuotas[category]), target - results.length);
    if (quota <= 0) continue;
    let filled = 0;
    for (const { p } of fresh) {
      if (filled >= quota) break;
      if (inferTag(p.productName) !== category) continue;
      if (await tryAddProduct(p)) filled++;
    }
    diagnostics.mandatoryQuotaFilled[category] = filled;
    if (filled < quota) {
      console.warn(`⚠️ Categoria obrigatória "${category}": só ${filled}/${quota} produtos elegíveis nesta rodada (o restante estaria em cooldown ou não passou nos filtros).`);
    }
  }

  // FAIXAS DE PREÇO (priceTierQuotas em bot-config.json): vaga MÍNIMA por faixa,
  // das mais caras para as mais baratas, para o catálogo não ficar 87% entre R$ 10
  // e 30. Só entra quem passou no portão de qualidade da faixa (qualityByPriceTier:
  // mais vendas + nota maior) e está fora do cooldown; dentro da faixa vale a
  // pontuação geral (vendas, nota, desconto, comissão, custo-benefício). O que já
  // entrou por outras regras conta para a cota.
  const priceTiers = (Array.isArray(config.priceTierQuotas) ? config.priceTierQuotas : [])
    .slice()
    .sort((a, b) => toNumber(b.min) - toNumber(a.min));
  diagnostics.priceTierTarget = {};
  diagnostics.priceTierFilled = {};
  for (const tier of priceTiers) {
    const min = toNumber(tier.min);
    const max = tier.max == null ? Infinity : toNumber(tier.max);
    const label = String(tier.label || `${min}-${max}`);
    const inTier = (price) => price >= min && price < max;
    const quota = toNumber(tier.quota);
    const already = [...selectedMeta.values()].filter((m) => inTier(m.price)).length;
    const need = Math.min(quota - already, target - results.length);
    diagnostics.priceTierTarget[label] = quota;
    let filled = 0;
    if (need > 0) {
      for (const { p } of fresh) {
        if (filled >= need) break;
        if (!inTier(catalogMinPrice(p))) continue;
        if (await tryAddProduct(p)) filled++;
      }
    }
    diagnostics.priceTierFilled[label] = already + filled;
    if (already + filled < quota) {
      console.warn(`⚠️ Faixa "${label}": ${already + filled}/${quota} (poucos produtos com vendas/nota suficientes e fora do cooldown nesta rodada).`);
    }
  }

  // ÓTIMOS DESCONTOS (dealQuota): vaga mínima para produto com desconto grande E
  // nota alta E muitas vendas — o desconto sozinho não basta (pode ser preço
  // "de" inflado); a prova de qualidade é o que segura.
  diagnostics.dealQuotaTarget = toNumber(dealCfg.quota);
  {
    const already = [...selectedMeta.values()].filter((m) => m.deal).length;
    const need = Math.min(toNumber(dealCfg.quota) - already, target - results.length);
    let filled = 0;
    if (need > 0) {
      for (const { p } of fresh) {
        if (filled >= need) break;
        if (!isGreatDeal(p)) continue;
        if (await tryAddProduct(p)) filled++;
      }
    }
    diagnostics.dealQuotaFilled = already + filled;
  }

  // Primeiro garantimos algumas oportunidades de alta comissão. Essas vagas
  // são apenas uma parte do catálogo; elas não impedem a entrada de produtos
  // de baixa comissão quando forem melhores em preço/qualidade/vendas.
  for (const tier of ['30+', '20-29.99', '10-19.99']) {
    const alreadyInTier = [...selectedMeta.values()].filter((m) => m.ctier === tier).length;
    const quota = Math.min(toNumber(commissionQuotas[tier]) - alreadyInTier, target - results.length, maxHighCommission - selectedHighCommission);
    if (quota <= 0) { diagnostics.commissionQuotaFilled[tier] = alreadyInTier; continue; }
    let filled = 0;

    for (const { p } of fresh) {
      if (filled >= quota) break;
      if (commissionTier(p) !== tier) continue;
      if (await tryAddProduct(p, { enforceCommissionCap: false })) filled++;
    }

    diagnostics.commissionQuotaFilled[tier] = alreadyInTier + filled;
  }

  // Vaga garantida por categoria (categoryQuotas em bot-config.json).
  // Sem isso, a pontuação por preço sozinha afunda item de ticket maior
  // (smartphone, notebook, geladeira) atrás de qualquer acessório barato —
  // era exatamente por isso que "celular" e "notebook" praticamente não
  // apareciam no catálogo mesmo tendo keywords de busca para eles.
  const categoryQuotas = config.categoryQuotas || {};
  diagnostics.categoryQuotaFilled = {};
  for (const category of Object.keys(categoryQuotas)) {
    const alreadyInCategory = [...selectedMeta.values()].filter((m) => m.tag === category).length;
    const quota = Math.min(toNumber(categoryQuotas[category]) - alreadyInCategory, target - results.length);
    if (quota <= 0) { diagnostics.categoryQuotaFilled[category] = alreadyInCategory; continue; }
    let filled = 0;
    for (const pool of [fresh]) {
      for (const { p } of pool) {
        if (filled >= quota) break;
        if (inferTag(p.productName) !== category) continue;
        if (await tryAddProduct(p)) filled++;
      }
      if (filled >= quota) break;
    }
    diagnostics.categoryQuotaFilled[category] = alreadyInCategory + filled;
  }

  // Preenche o restante do alvo pela pontuação geral, somente com produtos frescos.
  for (const pool of [fresh]) {
    for (const { p } of pool) {
      if (results.length >= target) break;
      await tryAddProduct(p);
    }
    if (results.length >= target) break;
  }

  diagnostics.highCommissionSelected = selectedHighCommission;
  diagnostics.highCommissionCapReached = selectedHighCommission >= maxHighCommission && maxHighCommission > 0;
  // Distribuição final por preço (para conferir no sync-meta.json se está barato o bastante).
  {
    const prices = [...selectedMeta.values()].map((m) => m.price);
    const count = (a, b) => prices.filter((v) => v >= a && v < b).length;
    diagnostics.priceDistribution = {
      'ate R$ 29': count(0, 30), 'R$ 30-49': count(30, 50), 'R$ 50-99': count(50, 100),
      'R$ 100-299': count(100, 300), 'R$ 300+': count(300, Infinity)
    };
  }
  diagnostics.affiliateLinkFailures = linkFailures;
  diagnostics.freshPublished = results.filter((r) => isFreshEnough(r.itemId, history, runCount, cooldownRuns)).length;
  diagnostics.repeatPublished = results.length - diagnostics.freshPublished;
  return results;
}

// Remove do histórico entradas muito antigas (fora até de uma janela generosa
// de cooldown) e limita o tamanho do arquivo, para product-history.json não
// crescer sem controle ao longo de semanas/meses de execução automática.
function pruneHistory(history, runCount, cooldownRuns) {
  const keepWindowRuns = Math.max(cooldownRuns * 6, 24);
  const maxEntries = 20000;
  const entries = Object.entries(history).filter(
    ([, v]) => Number.isFinite(v?.lastRun) && runCount - v.lastRun <= keepWindowRuns
  );
  entries.sort((a, b) => b[1].lastRun - a[1].lastRun);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

// NOTA: esta função existia para "completar" o catálogo com itens do ciclo
// anterior quando a coleta dinâmica vinha incompleta. Foi REMOVIDA de propósito
// do fluxo principal (ver main()): misturar itens novos com itens do ciclo
// passado sem checar o histórico de cooldown reintroduzia repetição — o
// próprio problema que o usuário pediu para eliminar 100%. Preferimos
// publicar um catálogo um pouco menor (mas 100% fresco) a "completar" com
// itens estáticos. Mantida aqui apenas como referência histórica, sem uso.
function mergeWithPrevious_UNUSED(dynamic, previous, target) {
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
    maxProducts: 500,
    minDynamicProducts: 250,
    pagesPerKeyword: 1,
    limitPerQuery: 50,
    topPerformingLimit: 50,
    includeTopPerforming: true,
    rotateSortType: true,
    pageRotationSpan: 3,
    keywordBatchSize: 200,
    repeatCooldownRuns: 4,
    minPrice: 10,
    minRating: 4.5,
    requireRating: true,
    allowedShopTypes: [1, 2, 4],
    allowUnknownShopType: false,
    allowLegacyPreviousWithoutShopType: true,
    blockedInternationalShopNamePatterns: ['international','importadora','importado','imports','china','japao','japão','usa','united','global','world','mundo mix','temu','aliexpress','shein','shop global','overseas'],
    viralKeywords: [],
    viralKeywordsPerRun: 28,
    viralLimitPerKeyword: 50,
    viralBonus: 10,
    viralCategoriesBoost: {},
    commissionQuotas: { '10-19.99': 75, '20-29.99': 20, '30+': 5 },
    maxCommissionShare: 0.25,
    highCommissionKeywords: ['ofertas', 'promocao', 'moda', 'beleza', 'casa', 'cozinha', 'eletronicos', 'fitness'],
    highCommissionLimitPerKeyword: 30,
    keywords: [],
    subIds: ['achadosshopeebsf'],
    trendingCategoryBoost: {},
    categoryQuotas: {},
    mandatoryKeywords: [],
    mandatoryQuotas: {},
    pinnedProducts: [],
    priceTierQuotas: [],
    qualityByPriceTier: [],
    premiumKeywords: []
  });
  const fixed = readJson(FIXED_FILE, []);
  const previous = readJson(OUTPUT_FILE, []);
  const previousMeta = readJson(META_FILE, {});
  const history = readJson(HISTORY_FILE, {});
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
    runCount,
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
      dynamic = await buildDynamicCatalog(candidates, config, diagnostics, history, runCount);
      console.log(`✅ ${dynamic.length} produtos dinâmicos (${diagnostics.freshPublished} novos; ${diagnostics.repeatPublished} repetidos).`);
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
  if (dynamic.length >= minDynamic) {
    // Publica só o que foi coletado NESTA rodada — 100% fresco, sem misturar
    // com o ciclo anterior. Se vier um pouco abaixo do alvo máximo mas acima
    // do mínimo aceitável, ainda assim é tudo novo (fica marcado como
    // "api-dynamic-partial" só para fins de diagnóstico, o site trata igual).
    output = dynamic.map((p) => ({ ...p, source: 'api-dynamic' }));
    source = dynamic.length >= target ? 'api-dynamic' : 'api-dynamic-partial';
  } else if (dynamic.length > 0) {
    // Veio bem abaixo do mínimo, mas ainda assim é produto novo de verdade.
    // Preferimos publicar um catálogo menor e 100% fresco a "completar" com
    // itens antigos só para bater um número redondo — isso é o que causava
    // a sensação de "os mesmos produtos fixos sempre voltando".
    output = dynamic.map((p) => ({ ...p, source: 'api-dynamic' }));
    source = 'api-dynamic-partial';
    console.warn(`⚠️ Só ${dynamic.length}/${target} produtos dinâmicos válidos (abaixo do mínimo de ${minDynamic}); publicando mesmo assim, 100% novos, sem completar com itens antigos.`);
  } else if (Array.isArray(previous) && previous.length > 0) {
    // Falha total nesta rodada específica: mantém somente itens do catálogo
    // anterior que ainda obedecem às regras públicas de preço/nota/loja.
    const safePrevious = previous.filter((p) => {
      const price = parsePrice(p?.now);
      const rating = ratingNumber(p?.rating);
      const shopTypes = normalizedShopTypes(p?.shopType);
      const allowed = new Set((config.allowedShopTypes || [1,2,4]).map(Number));
      const linkOk = /^https?:\/\/(?:www\.)?shopee\.com\.br\//i.test(String(p?.productLink || ''));
      // Dados publicados antes desta versão podem não ter trazido shopType.
      // Como eles vieram do endpoint BR e já passaram pela limpeza local,
      // permitimos a proveniência legada para evitar catálogo vazio numa
      // falha temporária da API. Novos candidatos continuam exigindo shopType.
      const shopOk = shopTypes.length
        ? shopTypes.some((t) => allowed.has(t))
        : (config.allowLegacyPreviousWithoutShopType === true && p?.marketplace === 'BR');
      const ratingOk = rating >= Number(config.minRating || 4.5);
      const maxOk = !(Number(config.maxPrice) > 0) || price <= Number(config.maxPrice);
      return price >= Number(config.minPrice || 10) && maxOk && ratingOk && linkOk && shopOk && !shopNameLooksInternational(p?.shopName, config);
    });
    output = safePrevious;
    source = previousIsDynamic ? 'previous-dynamic-filtered' : 'previous-fallback-filtered';
    console.warn(`⚠️ Nenhum produto dinâmico válido nesta rodada; mantendo ${safePrevious.length} item(ns) anterior(es) que ainda obedecem aos filtros.`);
  } else {
    const uniqueFixed = dedupeEquivalentProducts(fixed, diagnostics);
    output = fixedAsFallback(uniqueFixed, config).map((p) => ({ ...p, source: 'fixed-fallback' }));
    source = 'fixed-fallback';
    console.warn('⚠️ Primeira execução sem retorno suficiente da API; publicando catálogo inicial fixo (temporário, até a próxima rodada trazer produtos reais).');
  }

  const affiliateLinks = output.map((p) => p.affLink).filter(Boolean);
  writeJson(OUTPUT_FILE, output);
  writeJson(LINKS_FILE, affiliateLinks);
  const completedAt = new Date().toISOString();
  diagnostics.dynamicPublished = dynamic.length;

  // Registra no histórico persistente TUDO que está sendo mostrado agora
  // (o que garante o cooldown de repetição na próxima rodada), e limpa
  // entradas antigas para o arquivo não crescer sem limite.
  const cooldownRuns = Math.max(0, config.repeatCooldownRuns ?? 4);
  for (const p of output) {
    if (!p?.id) continue;
    history[String(p.id)] = { lastRun: runCount, lastShownAt: completedAt };
  }
  const prunedHistory = pruneHistory(history, runCount, cooldownRuns);
  writeJson(HISTORY_FILE, prunedHistory);
  diagnostics.historyEntries = Object.keys(prunedHistory).length;

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
