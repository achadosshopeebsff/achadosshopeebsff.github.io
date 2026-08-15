/**
 * scrape-all.js
 * -----------------------------------------------------------------
 * Lê /links.json (um link de produto Shopee por linha da lista),
 * abre cada página com navegador headless, extrai título, preço,
 * avaliação, descrição e imagem usando as classes reais da Shopee,
 * e grava tudo em /products.json — que é o arquivo que o site lê.
 *
 * Isso roda automaticamente via GitHub Actions (veja
 * .github/workflows/update-products.yml). Você não precisa rodar
 * isso na mão — só editar o links.json e dar commit/push.
 *
 * AVISO: as classes da Shopee (auau15, uLEz5u, pyzxvq/pw3J3G, cDKs6x)
 * são geradas pelo build deles e podem mudar sem aviso. Se um dia
 * o products.json parar de vir com dados certos, inspecione a
 * página de novo e atualize os seletores abaixo.
 * -----------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const LINKS_FILE = path.join(ROOT, 'links.json');
const OUTPUT_FILE = path.join(ROOT, 'products.json');

async function scrapeOne(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 900 });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.auau15', { timeout: 20000 }).catch(() => {});

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
  for (const url of links) {
    console.log('Lendo:', url);
    const product = await scrapeOne(browser, url.trim());
    if (product) results.push(product);
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nProntos: ${results.length}/${links.length} produtos salvos em products.json`);
}

main();
