# achadosshopeebsf — catálogo automático de achadinhos Shopee

O projeto usa a **Shopee Affiliate Open API (Brasil)** com duas fases:

1. **Catálogo inicial:** os 20 produtos fornecidos no `fixed-products.json` ficam publicados desde o primeiro acesso para o site nunca começar vazio.
2. **Catálogo automático:** após uma sincronização válida, o bot consulta `productOfferV2` por palavras-chave e também uma lista `top-performing`, ranqueia os melhores produtos e publica **30 itens a cada ciclo** (`maxProducts` em `bot-config.json`). Os produtos dinâmicos usam o `offerLink` afiliado retornado pela API — que já carrega o tracking da sua conta (ligada ao `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET`); se esse campo vier vazio, o bot tenta `generateShortLink` com o `productLink` e os `subIds` configurados, para manter o rastreio de origem.

## Atualização

- GitHub Actions: **a cada 30 minutos** (`00` e `30` de cada hora, UTC).
- Também roda em `push` relevante e pode ser acionado manualmente.
- `sync-meta.json` registra a última conclusão e calcula a próxima atualização para o contador do site.
- O navegador verifica `products.json`/`sync-meta.json` a cada 20s (sem chamar a Shopee diretamente) e reinicia o relógio de contagem regressiva sempre que lê um `nextUpdateAt` válido.

### Correção do relógio parado

O contador regressivo do site ficava travado em `30:00` porque `loadMeta()` não retornava nenhum valor — então a condição que disparava `startCountdown()` nunca era verdadeira, mesmo com o `sync-meta.json` correto. Isso foi corrigido: agora o relógio inicia sempre que existe um `nextUpdateAt` válido em memória, e a checagem do servidor passou de 60s para 20s para refletir mais rápido cada nova publicação do bot.

## Regra para não deixar vazio (e nunca ficar "travado")

Se uma execução da API falhar ou retornar poucos produtos válidos:

- produtos dinâmicos novos, mesmo que poucos, **são sempre publicados** — o bot completa o restante do catálogo com os itens anteriores, em vez de descartar tudo. Antes, se a coleta não batesse 24 produtos válidos, o ciclo inteiro era jogado fora e `products.json`/`links.json` ficavam idênticos ao anterior por tempo indefinido; isso foi corrigido.
- na primeira execução sem catálogo anterior, os 20 produtos fixos são publicados;
- `products.json` nunca é zerado por uma falha temporária da Shopee.

## Por que às vezes o catálogo parece não mudar

- `sync-meta.json` agora traz um campo `diagnostics` em toda execução, com: contagem de produtos por palavra-chave, quantos candidatos foram descartados (sem imagem/link), quantos links de afiliado falharam ao gerar, e uma lista `errors` com os erros reais devolvidos pela Shopee (com o código e uma explicação em português).
- Se `diagnostics.apiOk` vier `false`, a chamada de teste inicial já falhou — normalmente é credencial errada (`10020`) ou acesso à API não liberado (`10035`). Confira `diagnostics.errors[0]` para o motivo exato.
- Isso pode ser visto direto no arquivo publicado no repositório, sem precisar abrir o log do GitHub Actions.

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
