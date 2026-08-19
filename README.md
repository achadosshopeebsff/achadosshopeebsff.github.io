# achadosshopeebsf — catálogo automático de achadinhos Shopee

O projeto usa a **Shopee Affiliate Open API (Brasil)** com duas fases:

1. **Catálogo inicial:** os 20 produtos fornecidos no `fixed-products.json` ficam publicados desde o primeiro acesso para o site nunca começar vazio.
2. **Catálogo automático:** após uma sincronização válida, o bot consulta `productOfferV2` por palavras-chave e também uma lista `top-performing`, ranqueia os melhores produtos e publica **até 90 itens a cada ciclo** (`maxProducts` em `bot-config.json` — pode ser aumentado ainda mais, o pool de candidatos costuma passar de 4.000 produtos únicos por rodada). Os produtos dinâmicos usam o `offerLink` afiliado retornado pela API — que já carrega o tracking da sua conta (ligada ao `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET`); se esse campo vier vazio, o bot tenta `generateShortLink` com o `productLink` e os `subIds` configurados, para manter o rastreio de origem. **Garantia:** um produto sem link de afiliado válido (nem `offerLink` nem `generateShortLink` bem-sucedido) é descartado e **nunca** é publicado no site — ver `generateAffiliateLink()` e o `if (!affiliateLink) { linkFailures++; continue; }` em `buildDynamicCatalog()` no `scrape-all.js`. Ou seja: todo produto que aparece no site sempre carrega seu link de afiliado.
3. **Rotação de ordenação e de página:** a cada execução o bot alterna o `sortType` da busca (mais vendidos → maior comissão → relevância → menor preço, controlado por `rotateSortType`) **e** a página inicial de cada keyword (1 → 2 → 3 → 1…, controlado por `pageRotationSpan`). Sozinho, girar só o `sortType` ainda pedia sempre a página 1, que a Shopee devolve quase idêntica de execução em execução — girar as duas coisas juntas dá 12 combinações diferentes por palavra-chave (~6h) antes de repetir a mesma busca exata. O número da execução fica salvo em `sync-meta.json` (`runCount`).
4. **Sem repetição entre ciclos — histórico persistente com "descanso" (cooldown):** o bot mantém `product-history.json`, commitado a cada execução, com a data/execução em que cada produto foi publicado pela última vez. Um produto só pode voltar a ser publicado depois de `repeatCooldownRuns` execuções (padrão 4 = ~2h). Isso é diferente de só comparar com o `products.json` do ciclo anterior: antes, um produto podia sumir por 1 ciclo e "parecer novo" de novo no ciclo seguinte — era exatamente esse o bug do "na 3ª vez repete os produtos da 1ª vez". Com o histórico persistente isso não acontece mais, mesmo que o produto tenha desaparecido do catálogo publicado no meio do caminho. Fica registrado em `diagnostics.repeatPublished`/`diagnostics.historyEntries` no `sync-meta.json`.
5. **Qualidade e preço:** produtos com avaliação informada abaixo de `minRating` (padrão 4.0) são descartados; a pontuação usa escala logarítmica de preço (favorece achados baratos sem excluir itens de ticket maior, como smartphones, se tiverem boa nota/vendas) e dá mais peso à avaliação. Inclui categoria "Smartphones" com keywords dedicadas (`smartphone`, `smartphone barato`, `celular android`, `celular 5g barato`, `smartphone entrada`).
6. **Erros transitórios da Shopee (`[10000]`/`[10030]`) agora têm nova tentativa automática** (com espera crescente) antes de desistir de uma palavra-chave — a própria Shopee documenta que o erro `10000` "costuma se resolver sozinho", e a forma de resolver sozinho é tentar de novo.

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

### Correção do "às vezes preciso rodar manualmente pra destravar" (bug de auto-disparo)

Causa raiz encontrada: o workflow disparava em `push` para os caminhos `products.json` e `links.json` — mas esses dois arquivos são commitados pelo **próprio bot** ao final de cada execução. Ou seja, cada atualização automática disparava, sozinha, uma nova execução do workflow por push, fora do intervalo de 30 minutos e competindo com o próximo ciclo agendado (que cancelava/era cancelado via `concurrency: cancel-in-progress`). Isso explicava tanto os "travamentos" quanto rajadas de erro `[10000]` da Shopee (chamadas feitas com muito mais frequência do que o intervalo configurado). Corrigido: `products.json`, `links.json` e `product-history.json` foram removidos da lista de caminhos que disparam o workflow — só mudanças feitas por humanos em `fixed-products.json`, `bot-config.json`, `scraper/**` ou no próprio workflow disparam uma execução por push; o resto do tempo, só o `schedule` (30 em 30 min) ou `workflow_dispatch` (manual) rodam o bot.

Nota: o cron do GitHub Actions é "melhor esforço" — em horários de pico da plataforma, o disparo agendado pode atrasar alguns minutos (isso é uma limitação do GitHub, não do bot). O botão "Run workflow" continua disponível a qualquer momento como reforço, mas não deve mais ser necessário como muleta pra destravar o ciclo.

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
- `product-history.json`: memória persistente de quando cada produto foi publicado por último (usada para o cooldown anti-repetição). Cresce de forma controlada — entradas muito antigas são removidas automaticamente a cada execução.
- `bot-config.json`: palavras-chave, quantidade, ranking, frequência, cooldown de repetição e rotação de página.
- `sync-meta.json`: relógio da sincronização + diagnóstico detalhado de cada execução.
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
