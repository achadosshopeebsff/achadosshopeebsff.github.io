/**
 * scrape-all.js
 * -----------------------------------------------------------------
 * Lê /links.json, abre cada página com navegador headless, extrai
 * título, preço, avaliação, descrição e imagem usando as classes
 * reais da Shopee, e grava tudo em /products.json.
 *
 * Roda automaticamente via GitHub Actions
 * (.github/workflows/update-products.yml). Você só edita links.json
 * e dá commit/push — o resto é automático.
 *
 * Se não encontrar o título, salva um print de tela + o HTML da
 * página em /debug, pra você diagnosticar (captcha, aviso de
 * cookies, tela de app, etc).
 *
 * AVISO: as classes da Shopee (auau15, uLEz5u, pyzxvq/pw3J3G, cDKs6x)
 * são geradas pelo build deles e podem mudar sem aviso. Se um dia
 * parar de achar os dados, inspecione a página de novo e atualize
 * os seletores abaixo.
 * -----------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const LINKS_FILE = path.join(ROOT, 'links.json');
const OUTPUT_FILE = path.join(ROOT, 'products.json');
const DEBUG_DIR = path.join(ROOT, 'debug');

async function scrapeOne(browser, url, index) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });
  await page.setViewport({ width: 1366, height: 900 });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      const text = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : '';
      };
      const title = text('.auau15');
      const rating = text('.flex.uLEz5u') || text('.uLEz5u');
      const priceRaw = text('.pyzxvq.pw3J3G') || text('.pw3J3G');
      const desc = text('.cDKs6x');
      const imgEl = document.querySelector('img[src*="susercontent.com"]');
      const image = imgEl ? imgEl.src : '';
      return { title, rating, priceRaw, desc, image };
    });

    if (!data.title) {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      await page.screenshot({ path: path.join(DEBUG_DIR, `produto-${index}.png`), fullPage: true });
      const html = await page.content();
      fs.writeFileSync(path.join(DEBUG_DIR, `produto-${index}.html`), html, 'utf-8');
      console.log(`⚠️  Não encontrei o título em ${url} — print e HTML salvos em debug/produto-${index}.png`);
    }

    await page.close();
    return {
      affLink: url,
      title: data.title || 'Produto Shopee',
      desc: data.desc || '',
      image: data.image || '',
      tag: 'Shopee',
      accent: '#ee4d2d',
      icon: '🛍️',
      now: data.priceRaw || '',
      old: '',
      off: '',
      rating: data.rating || '',
      updatedAt: new Date().toISOString()
    };
  } catch (err) {
    await page.close();
    console.error(`Falha ao ler ${url}:`, err.message);
    return null;
  }
}

async function main() {
  if (!fs.existsSync(LINKS_FILE)) {
    console.error('links.json não encontrado.');
    process.exit(1);
  }

  const links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf-8'));
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = [];
  for (let i = 0; i < links.length; i++) {
    console.log('Lendo:', links[i]);
    const product = await scrapeOne(browser, links[i].trim(), i);
    if (product) results.push(product);
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nProntos: ${results.length}/${links.length} produtos salvos em products.json`);
}

main();
