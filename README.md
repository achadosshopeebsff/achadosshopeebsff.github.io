# achadosshopeebsf — catálogo automático de achadinhos Shopee

O projeto usa a **Shopee Affiliate Open API (Brasil)** com duas fases:

1. **Catálogo inicial:** os 20 produtos fornecidos no `fixed-products.json` ficam publicados desde o primeiro acesso para o site nunca começar vazio.
2. **Catálogo automático:** após uma sincronização válida, o bot consulta `productOfferV2` por palavras-chave e também uma lista `top-performing`, ranqueia os melhores produtos e publica **50 itens a cada ciclo** (`maxProducts` em `bot-config.json`). Os produtos dinâmicos usam o `offerLink` afiliado retornado pela API — que já carrega o tracking da sua conta (ligada ao `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET`); se esse campo vier vazio, o bot tenta `generateShortLink` com o `productLink` e os `subIds` configurados, para manter o rastreio de origem. **Garantia:** um produto sem link de afiliado válido (nem `offerLink` nem `generateShortLink` bem-sucedido) é descartado e **nunca** é publicado no site — ver `generateAffiliateLink()` e o `if (!affiliateLink) { linkFailures++; continue; }` em `buildDynamicCatalog()` no `scrape-all.js`. Ou seja: todo produto que aparece no site sempre carrega seu link de afiliado.
3. **Rotação de ordenação:** a cada execução o bot alterna o `sortType` da busca (mais vendidos → maior comissão → relevância → menor preço, nessa ordem, controlado por `rotateSortType`) para ampliar a diversidade dos candidatos coletados. O número da execução fica salvo em `sync-meta.json` (`runCount`).
4. **Sem repetição entre ciclos:** antes de publicar, o bot compara com o `products.json` do ciclo anterior e dá prioridade máxima a produtos que **ainda não apareceram** no site. Só repete um item se realmente não houver estoque de opções novas suficiente (fica registrado em `diagnostics.repeatPublished` no `sync-meta.json`). Isso resolve o problema de "muda uma vez e depois trava nos mesmos produtos" — antes, o re-ranqueamento local pela pontuação sempre convergia para os mesmos itens, ignorando a rotação da busca.
5. **Qualidade e preço:** produtos com avaliação informada abaixo de `minRating` (padrão 4.0) são descartados; a pontuação usa escala logarítmica de preço (favorece achados baratos sem excluir itens de ticket maior, como smartphones, se tiverem boa nota/vendas) e dá mais peso à avaliação. Inclui categoria "Smartphones" com keywords dedicadas (`smartphone`, `smartphone barato`, `celular android`, `celular 5g barato`, `smartphone entrada`).

## Categorias e keywords (atualizado ago/2026, foco 2026 → 2027)

O `bot-config.json` traz **132 keywords** organizadas pelas 10 categorias de maior consumo/GMV na Shopee Brasil (relatório de tendências fornecido pelo dono do site), para o bot buscar sempre esses produtos:

1. **Tecnologia e eletrônicos** — fones TWS, power bank, capinhas/películas, smartwatch, caixa de som, projetor, notebook, drone, câmeras de segurança, smartphones, etc.
2. **Casa, decoração e organização** (categoria nº1 em GMV) — papel de parede adesivo, luminárias, organizadores, tapetes, lençóis, cortinas blackout, umidificador, etc.
3. **Cozinha e eletrodomésticos** — air fryer, panelas, mini processadores, liquidificadores, utensílios práticos.
4. **Beleza, maquiagem e cuidados pessoais** — lip tint, bases, blush, escovas secadoras, séruns, skincare coreano, massageadores faciais.
5. **Moda feminina, masculina e acessórios** — croppeds, vestidos, bolsas, óculos de sol, coturnos, relógios masculinos.
6. **Pets** — areia sanitária, comedouros elevados, fontes de água, camas, antipulgas, brinquedos.
7. **Auto e moto** — retrovisores, escapamentos, processadores de áudio automotivo, pneus, ferramentas.
8. **Bem-estar, fitness e saúde** — óleos essenciais/difusores, bicicleta ergométrica, faixas elásticas, suplementos.
9. **Brinquedos, bebês e diversão** — brinquedos Montessori, bebê reborn, papelaria.
10. **Outros de alto giro** — capacetes, ferramentas manuais, aspiradores portáteis.

`bot-config.json > trendingCategoryBoost` dá um reforço de pontuação no ranking (`scoreProduct`) para as categorias que o relatório aponta como maior crescimento projetado até 2027 (Casa, Beleza, Pets, Auto & Moto, Eletrônicos, Cozinha) — sem excluir as demais, que continuam competindo normalmente pelo preço/vendas/avaliação. `inferTag()` foi reescrita para classificar essas categorias corretamente (Casa, Auto & Moto, Pets, Brinquedos, etc.) a partir do nome do produto retornado pela Shopee.

Para ajustar a lista de produtos buscados no futuro, edite o array `keywords` em `bot-config.json` — não é necessário mexer no `scrape-all.js` para adicionar/remover termos de busca.

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
