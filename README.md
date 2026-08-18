# achadosshopeebsf

Site estático de achados Shopee com atualização automática pela **Shopee Affiliate Open API**.

## O que foi otimizado

- Removido Puppeteer/scraping de página da Shopee.
- O navegador do visitante não chama a API da Shopee.
- `index.html` usa menos animações, menos blur e menos trabalho no scroll.
- Cards usam `content-visibility`, imagens `lazy` e `decoding="async"`.
- DOM criado com `DocumentFragment` em vez de montar um HTML gigante com `innerHTML`.
- Layout responsivo para telas pequenas, tablets e desktop.
- Melhorias de acessibilidade: skip link, foco visível, `aria-live`, rótulos de botões e alvos de toque.
- Produtos/preços são salvos em `products.json`, então o carregamento do site continua rápido mesmo quando a Shopee está lenta.
- O workflow atualiza os dados a cada 6 horas e também quando `links.json` ou o código do sincronizador muda.

## Configurar as credenciais

**Não coloque App ID/Secret dentro do `index.html`, JavaScript do navegador, `products.json`, Git ou arquivos públicos.**

No GitHub:

1. Abra `Settings → Secrets and variables → Actions`.
2. Crie `SHOPEE_APP_ID` com seu App ID.
3. Crie `SHOPEE_APP_SECRET` com sua Secret.
4. Rode `Actions → Atualizar produtos da Shopee → Run workflow`.

As credenciais ficam somente no ambiente do GitHub Actions.

## Produtos

Edite `links.json` com URLs da Shopee. O sincronizador resolve links curtos, identifica `shopId/itemId` quando disponível e consulta `productOfferV2` para título, imagem, preço, desconto, vendas, avaliação e link de oferta.

A API brasileira de afiliados é GraphQL e disponibiliza `productOfferV2` e `generateShortLink`; o endpoint usado pelo projeto é `https://open-api.affiliate.shopee.com.br/graphql`. citeturn592839search0turn628693search0

### Observação importante sobre preço antigo

A API pública não fornece necessariamente um campo de “preço antigo” independente. Quando existe `priceDiscountRate`, o projeto estima o preço original a partir do preço atual; por isso ele pode variar alguns centavos em relação ao anúncio visual da Shopee. citeturn592839search1

## Segurança

Se uma credencial real já foi compartilhada fora do seu cofre de secrets, prefira regenerá-la no painel da Shopee e depois salvar a nova chave apenas como GitHub Secret.

## Logo

Coloque `logo.png` na raiz do projeto. O HTML já usa dimensões fixas para evitar layout shift.

## Estrutura

- `index.html` — frontend rápido e responsivo.
- `products.json` — cache público dos produtos, usado pelo frontend.
- `links.json` — URLs de origem dos produtos.
- `scraper/scrape-all.js` — sincronização com a API.
- `.github/workflows/update-products.yml` — atualização automática.
