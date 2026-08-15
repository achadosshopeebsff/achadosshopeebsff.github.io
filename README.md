# achadosshopeebsf

Site de achados/afiliados da Shopee com busca automática de produtos.

## Como adicionar um produto novo

1. Abra `links.json`.
2. Adicione o link do produto (ou link de afiliado curto `s.shopee.com.br/...`) na lista.
3. Dê commit e push.
4. O GitHub Actions roda sozinho, lê o produto na Shopee e atualiza `products.json`.
5. Em alguns minutos o site já mostra o produto novo — nada precisa ser digitado no código.

O robô também roda automaticamente todo dia (worfklow agendado) para manter os preços atualizados.

## Rodar manualmente (opcional)

Se quiser forçar a atualização sem esperar:
1. Vá na aba **Actions** do repositório no GitHub.
2. Escolha o workflow **"Atualizar produtos da Shopee"**.
3. Clique em **"Run workflow"**.

## Estrutura

- `links.json` — só os links dos produtos (a única coisa que você edita manualmente).
- `products.json` — gerado automaticamente pelo robô (título, preço, foto, descrição, avaliação).
- `scraper/scrape-all.js` — o robô que lê a Shopee.
- `.github/workflows/update-products.yml` — o que dispara o robô automaticamente.
- `index.html` — o site, que carrega `products.json` sozinho.

## Se o robô parar de encontrar os dados

A Shopee muda o layout do site deles de vez em quando, o que muda as classes CSS usadas pelo robô (`auau15`, `uLEz5u`, `pyzxvq`/`pw3J3G`, `cDKs6x`). Se isso acontecer:
1. Abra um produto na Shopee pelo navegador.
2. Botão direito no título → Inspecionar → veja a classe atual.
3. Atualize os seletores em `scraper/scrape-all.js`.
