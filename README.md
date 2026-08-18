# achadosshopeebsf — catálogo automático de achadinhos Shopee

O projeto usa a **Shopee Affiliate Open API (Brasil)** com duas fases:

1. **Catálogo inicial:** os 20 produtos fornecidos no `fixed-products.json` ficam publicados desde o primeiro acesso para o site nunca começar vazio.
2. **Catálogo automático:** após uma sincronização válida, o bot consulta `productOfferV2` por palavras-chave e também uma lista `top-performing`, ranqueia os melhores produtos e publica até 80 itens. Os produtos dinâmicos usam o `offerLink` afiliado retornado pela API; se esse campo vier vazio, o bot tenta `generateShortLink` com o `productLink`.

## Atualização

- GitHub Actions: **a cada 30 minutos** (`00` e `30` de cada hora, UTC).
- Também roda em `push` relevante e pode ser acionado manualmente.
- `sync-meta.json` registra a última conclusão e calcula a próxima atualização para o contador do site.
- O navegador verifica o catálogo periodicamente sem chamar a Shopee diretamente.

## Regra para não deixar vazio

Se uma execução da API falhar ou retornar poucos produtos válidos:

- o catálogo anterior é preservado;
- na primeira execução sem catálogo anterior, os 20 produtos fixos são publicados;
- `products.json` nunca é zerado por uma falha temporária da Shopee.

## Arquivos

- `fixed-products.json`: somente o catálogo inicial/fallback.
- `products.json`: catálogo atualmente publicado.
- `links.json`: links afiliados correspondentes ao catálogo atualmente publicado.
- `bot-config.json`: palavras-chave, quantidade, ranking e frequência.
- `sync-meta.json`: relógio da sincronização.
- `scraper/scrape-all.js`: coletor + ranking + geração/preservação dos links afiliados.

## Secrets do GitHub

Configure em **Settings → Secrets and variables → Actions**:

- `SHOPEE_APP_ID`
- `SHOPEE_APP_SECRET`

Nunca coloque o Secret no HTML, JSON público ou outro arquivo versionado.

## API

Endpoint Brasil:
`https://open-api.affiliate.shopee.com.br/graphql`

A integração usa `productOfferV2` com `keyword`, `sortType`, `listType`, paginação e os campos compatíveis do objeto `ProductOfferV2`, como `itemId`, `productName`, `productLink`, `offerLink`, `imageUrl`, `priceMin`, `priceMax`, `priceDiscountRate`, `sales`, `ratingStar`, `commissionRate`, `commission`, `shopId` e `shopName`.

Referência: Explorer oficial da Shopee Affiliate Open API.


### Catálogo dinâmico
O bot tenta publicar 100 produtos por sincronização. O catálogo inicial fixo é apenas fallback para evitar página vazia. Após uma sincronização válida, `products.json` e `links.json` são regenerados com os produtos retornados pela API e seus links de afiliado.
