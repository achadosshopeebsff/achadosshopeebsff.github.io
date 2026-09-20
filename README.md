# achadosshopeebsf — catálogo automático de achadinhos Shopee

## Busca no catálogo e regra anti-repetição

O site possui uma busca instantânea no catálogo publicado. A pesquisa é feita no navegador sobre os produtos presentes em `products.json`, procurando por nome, descrição, categoria e loja. O `App Secret` permanece exclusivamente no GitHub Actions e nunca é enviado ao navegador.

Na seleção automática do catálogo, produtos com o mesmo `itemId` nunca são duplicados. Para itens equivalentes anunciados por lojas diferentes, o bot usa uma comparação conservadora de título e mantém a oferta mais barata quando os preços podem ser comparados. Variações com medidas/modelos diferentes continuam separadas porque números e medidas permanecem na assinatura de identidade.

Também existe uma reserva parcial de vagas para produtos com comissão de 10–19,99%, 20–29,99% e 30% ou mais. Essas faixas não dominam o catálogo: antes de entrar, os produtos continuam passando pelos filtros de qualidade e disputando espaço com preço, avaliação, vendas e desconto.


O projeto usa a **Shopee Affiliate Open API (Brasil)** com duas fases:

1. **Catálogo inicial:** os 20 produtos fornecidos no `fixed-products.json` ficam publicados desde o primeiro acesso para o site nunca começar vazio.
2. **Catálogo automático:** após uma sincronização válida, o bot consulta `productOfferV2` por palavras-chave e também uma lista `top-performing`, ranqueia os melhores produtos e publica **até 500 itens a cada ciclo** (`maxProducts` em `bot-config.json`). Os produtos dinâmicos usam o `offerLink` afiliado retornado pela API — que já carrega o tracking da sua conta (ligada ao `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET`); se esse campo vier vazio, o bot tenta `generateShortLink` com o `productLink` e os `subIds` configurados, para manter o rastreio de origem. **Garantia:** um produto sem link de afiliado válido (nem `offerLink` nem `generateShortLink` bem-sucedido) é descartado e **nunca** é publicado no site — ver `generateAffiliateLink()` e o `if (!affiliateLink) { linkFailures++; continue; }` em `buildDynamicCatalog()` no `scrape-all.js`. Ou seja: todo produto que aparece no site sempre carrega seu link de afiliado.
3. **Rotação de ordenação e de página:** a cada execução o bot alterna o `sortType` da busca (mais vendidos → maior comissão → relevância → menor preço, controlado por `rotateSortType`) **e** a página inicial de cada keyword (1 → 2 → 3 → 1…, controlado por `pageRotationSpan`). Sozinho, girar só o `sortType` ainda pedia sempre a página 1, que a Shopee devolve quase idêntica de execução em execução — girar as duas coisas juntas dá 12 combinações diferentes por palavra-chave (~6h) antes de repetir a mesma busca exata. O número da execução fica salvo em `sync-meta.json` (`runCount`).
4. **Sem repetição entre ciclos — histórico persistente com "descanso" (cooldown):** o bot mantém `product-history.json`, commitado a cada execução, com a data/execução em que cada produto foi publicado pela última vez. Um produto só pode voltar a ser publicado depois de `repeatCooldownRuns` execuções (padrão 4 = ~2h). Isso é diferente de só comparar com o `products.json` do ciclo anterior: antes, um produto podia sumir por 1 ciclo e "parecer novo" de novo no ciclo seguinte — era exatamente esse o bug do "na 3ª vez repete os produtos da 1ª vez". Com o histórico persistente isso não acontece mais, mesmo que o produto tenha desaparecido do catálogo publicado no meio do caminho. Fica registrado em `diagnostics.repeatPublished`/`diagnostics.historyEntries` no `sync-meta.json`.
5. **Qualidade e preço:** produtos com avaliação informada abaixo de `minRating` (padrão 4.0) são descartados; a pontuação usa escala logarítmica de preço (favorece achados baratos sem excluir itens de ticket maior, como smartphones, se tiverem boa nota/vendas) e dá mais peso à avaliação. Inclui categoria "Smartphones" com keywords dedicadas (`smartphone`, `smartphone barato`, `celular android`, `celular 5g barato`, `smartphone entrada`).
6. **Erros transitórios da Shopee (`[10000]`/`[10030]`) agora têm nova tentativa automática** (com espera crescente) antes de desistir de uma palavra-chave — a própria Shopee documenta que o erro `10000` "costuma se resolver sozinho", e a forma de resolver sozinho é tentar de novo.

## Cabelo liso (categoria com vaga garantida)

Produtos de alisamento — chapinha/prancha alisadora, escova alisadora/secadora, pente alisador, progressiva, alisante, botox/selagem capilar, protetor térmico etc. — têm **vaga garantida em todo ciclo**:

- `bot-config.json > mandatoryKeywords` (40 termos): buscados em **toda execução** (`mandatoryKeywordsPerRun` por vez, girando termos, páginas e `sortType`), fora da rotação em lotes das outras keywords.
- `bot-config.json > mandatoryQuotas`: `"Cabelo Liso": 30` — essas vagas são preenchidas **antes** das cotas de comissão/categoria. Para aumentar/diminuir, mude o número.
- `inferTag()` classifica esses produtos como `Cabelo Liso` (regex específica, para não pegar “lente progressiva”, “prancha de surf”, “alisador de massa” etc.).
- O produto ainda precisa passar nos filtros de preço (R$ 10+), nota (4,5★+), loja e link afiliado, e **continua valendo o cooldown anti-repetição**. Se a Shopee devolver poucos itens elegíveis em uma rodada, a cota pode ficar abaixo de 30 — isso aparece em `sync-meta.json > diagnostics.mandatoryQuotaFilled`.
- No site, aparece o filtro **Cabelo liso** logo abaixo da busca (junto com as outras categorias presentes), e o botão *Escanear* respeita o filtro escolhido.

## Produto fixado (kit Belkit Liso Obrigatório)

- “Liso Obrigatório” é a **linha da Belkit**. O kit *Kit Capilar PROFISSIONAL Belkit Liso Obrigatório 03 itens de 1 LITRO (Shampoo, Condicionador, Máscara)* está em `bot-config.json > pinnedProducts` (loja `1343471577`, item `20099888804`, do link `shopee.com.br/…-i.1343471577.20099888804`).
- Produto fixado entra em **toda rodada, em 1º lugar**, e **ignora o descanso anti-repetição**. Continua passando nos filtros (preço mínimo, nota 4,5+, loja do Brasil) e usa **sempre o link de afiliado da sua conta** (vem da API); nunca um link montado à mão.
- A busca é por `itemId` e, se falhar, por nome. Se a Shopee não devolver o item (fora do programa de afiliados, sem estoque, nota baixa…), o motivo aparece em `sync-meta.json > diagnostics.pinned` / `pinnedResult`.
- Para fixar outro produto, copie o bloco em `pinnedProducts` e troque `name`, `itemId` e `shopId` (os números estão no fim do link do produto).
- Termos da linha (`liso obrigatorio`, `belkit liso obrigatorio`, `kit capilar liso obrigatorio`…) também são buscados em toda rodada, e títulos com “Liso Obrigatório” são classificados como **Cabelo Liso**.

## Eletrônicos, virais, smartphones e caixas de som

- Só foi **acrescentado** (nada removido): +146 termos em `mandatoryKeywords` (fones invisíveis/bluetooth/TWS/ANC, carregadores 120W/GaN/65W, power bank, smartwatch, projetor, TV box, mouse/teclado gamer, webcam, câmera wifi, celulares por modelo…), buscados **em rodízio a toda rodada** (`mandatoryKeywordsPerRun`: 80).
- Cota reservada: `mandatoryQuotas` → **Eletrônicos 60**, **Caixas de Som 20** (categoria nova; antes ficavam soltas em Eletrônicos), além de **Smartphones 40** (`categoryQuotas`, já existia).
- Correção da classificação de smartphones: cartão de memória, pendrive/OTG, SSD, microfone de lapela e afins **não contam mais como “Smartphones”** (antes ocupavam as vagas de celular). Foram adicionados mais modelos reais (Galaxy A/M/S, Moto E/Edge/G, Realme, Infinix, Tecno, Xiaomi…).

## Custo-benefício: teto, faixas de preço, descontos, comissão e qualidade

**Regra de ouro: qualidade primeiro.** Nenhuma cota abaixo compra produto ruim: todo item precisa de **nota alta + prova de vendas**. Se faltar produto bom numa faixa, ela fica abaixo da cota (o bot publica um catálogo um pouco menor e 100% novo, nunca “completa” com item ruim).

- **Preço:** piso **R$ 10** (`minPrice`) e **teto R$ 1.000** (`maxPrice`) — vale para `priceMin` e `priceMax` (anúncio “de R$ 800 a R$ 6.000” não entra). O site também esconde qualquer item acima de R$ 1.000 (`MAX_PRICE_BRL` no `index.html`), então nada acima do teto aparece mesmo antes do próximo ciclo do bot.
- **Faixas graduais** (`priceTierQuotas`, vagas mínimas de 500): R$ 10–29: 90 · 30–49: 90 · 50–69: 70 · 70–99: 55 · 100–199: 50 · 200–499: 35 · 500–1.000: 20 (410 no total; o resto vem da pontuação geral). Quem já entrou por outra regra conta para a cota.
- **Portão de qualidade** (`qualityByPriceTier`, vale para TODAS as faixas): R$ 10–29: nota 4,6+ e 20+ vendas · 30–69: 4,6+ e 30+ · 70–199: 4,6+ e 40+ · 200–499: 4,7+ e 30+ · 500+: 4,7+ e 20+. Nota máxima com 0–4 vendas **não passa**. Nota mínima geral: `minRating` **4,6**.
- **Ótimos descontos** (`dealQuota`): vaga mínima de 100 para desconto **≥ 40% com nota ≥ 4,7 e ≥ 50 vendas**. Desconto sozinho não basta (o preço “de” pode ser inflado). A pontuação também premia “nota 4,9+ com 500+ vendas” e “desconto grande com nota/vendas altas”.
- **Comissão** (`commissionQuotas`): **30%+: 50** · 20–29,99%: 40 · 10–19,99%: 60; teto de 35% do catálogo com comissão 10%+ (`maxCommissionShare`). Produtos com **20%+ só entram com nota ≥ 4,7 e ≥ 30 vendas** (`highCommissionMinRating` / `highCommissionMinSales`): comissão alta nunca compensa produto ruim. A pontuação considera a **comissão esperada por venda (R$ = preço × %)** com teto baixo.
- **Smartphones:** só até R$ 1.000 e **a partir de R$ 250** (`tagMinPrice`; abaixo disso é brinquedo/golpe). Cartão de memória, pendrive, SSD, microfone etc. não contam como celular. Vagas garantidas de Smartphones: 30 (Notebooks: 10 — com o teto quase não existe).
- **Ordenação da busca:** `sortTypeRotation: [2,5,1,2]` (o “menor preço primeiro” foi removido, era ele que empurrava só barato). `premiumKeywords` agora são produtos de ticket médio/custo-benefício (celular de entrada, TV/monitor, eletrodomésticos, cadeira gamer, tênis, perfume…). Palavras que só trazem item acima de R$ 1.000 (iPhone etc.) foram retiradas.
- **Conferência** a cada rodada em `sync-meta.json > diagnostics`: `priceTierFilled`, `dealQuotaFilled`, `commissionQuotaFilled`, `mandatoryQuotaFilled`, `pinnedResult`.
- **Produto fixado:** vale piso/teto de preço, nota mínima e loja do Brasil, mas **não** o mínimo de vendas por faixa (é escolha do dono).
- Custo: o bot faz mais chamadas à API por rodada. Se ficar pesado, reduza `mandatoryKeywordsPerRun`, `premiumKeywordsPerRun` ou `highCommissionKeywordsPerRun`.

## Avaliações reais + vídeo no “Escanear”

Ao tocar em **Escanear**:

- **Vídeo do produto** toca **sem som**, translúcido, atrás do botão (esmaece para fora do anel). Se o produto não tem vídeo, nada aparece; nunca fica vídeo de outro produto. Não toca com *reduzir movimento* ativado nem no modo *economia de dados*.
- **Avaliações reais** do produto aparecem como banners pequenos, translúcidos, flutuando e sumindo (`ACHADOSSHOPEEBSFF` + perfil + estrelas + comentário). Em telas pequenas 1 por vez, no topo; em telas ≥ 960px até 2 no canto direito. O horário mostrado é o **da avaliação original** (“há 3 meses”), não “agora”, para não sugerir compra ao vivo.
- O *Escanear* prefere (~80%) produtos que têm avaliações/vídeo coletados.

- **Fundo do Escanear:** a foto do produto (a mesma do `cThumbImg`) aparece **ampliada e translúcida** atrás do botão, em camada própria (`#scanBackdrop`), então continua aparecendo mesmo sem vídeo do produto. Ao abrir a página mostra a foto do próximo achado; a cada Escanear troca para a do produto revelado. A transparência fica em `.scan-backdrop.on { opacity }` no CSS.
- **Notificações de promoção:** cada banner é um `<a>` de verdade com `href` = link de afiliado do produto (`affLink`, formato `s.shopee.com.br/…`), `target="_blank"` e `rel="nofollow sponsored noopener"`. Passar o mouse mostra o link; tocar abre em nova aba e mantém o site aberto. Produto sem `affLink` válido nunca vira notificação.

**De onde vêm os dados (importante):** a Shopee Affiliate Open API **não** traz avaliações nem vídeo. O script `scraper/fetch-media.js` (rodado pelo workflow depois do catálogo, com `continue-on-error`) consulta os endpoints públicos que a própria página do produto usa e grava `product-media.json`. Esses endpoints **não são oficiais** e a Shopee pode bloquear/alterar — principalmente para IPs de datacenter como o do GitHub Actions. Por isso:

- **Nada é inventado.** Só entra o que a Shopee devolveu, para aquele `itemId`: comentários com texto próprio (mín. 15 caracteres), sem links/telefone/contato, sem duplicata, nota ≥ `media.minReviewStars` (padrão 4). Nome e foto do perfil são os que a Shopee já expõe na avaliação (a Shopee mascara o nome de quem avalia como anônimo). Para não usar fotos de perfil: `media.includeAvatars: false`.
- **Sem bypass.** Requisições sequenciais e espaçadas (`requestDelayMs`), sem cookies/login e sem tentar contornar proteção anti-robô. Se vierem `blockedStreakLimit` bloqueios seguidos (403/429/captcha/rede), o script **para** sozinho.
- **Sem dados = sem efeito.** Produto sem avaliações/vídeo coletados simplesmente não mostra notificações/vídeo; o resto do site funciona igual.
- **Como saber se está funcionando:** abra `product-media.json > diagnostics` (`withReviews`, `withVideo`, `blockedResponses`, `stoppedEarly`, `lastError`). Se `stoppedEarly` for `"blocked"`, a Shopee está bloqueando o servidor do GitHub. Nesse caso dá para rodar `node scraper/fetch-media.js` numa máquina com IP residencial brasileiro e commitar o `product-media.json` — mas o catálogo troca a cada ciclo, então o resultado só vale para os produtos que estiverem publicados naquele momento.
- **Aviso:** consultar esses endpoints pode não estar de acordo com os Termos da Shopee. O risco é seu; se preferir, desligue com `"media": { "enabled": false }` em `bot-config.json`.
- Cobertura por rodada: `media.maxProductsPerRun` (160) dentro de `media.timeBudgetSeconds` (420 s), priorizando **Cabelo Liso** e depois os mais vendidos.

## Categorias e keywords (atualizado em setembro/2026)

O `bot-config.json` traz **861 keywords** organizadas pelas 10 categorias de maior consumo/GMV na Shopee Brasil (relatório de tendências fornecido pelo dono do site), para o bot buscar sempre esses produtos:

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

- GitHub Actions: **a cada 30 minutos** (`:07` e `:37` de cada hora, UTC, para evitar o pico de fila).
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

- produtos dinâmicos novos são publicados mesmo que sejam menos que o alvo, desde que passem pelos filtros; o bot não inventa produtos nem reintroduz itens em cooldown apenas para preencher o número.
- em falha temporária da API, o catálogo anterior só é mantido quando os itens ainda obedecem ao piso de R$10, nota mínima de 4,5 e às regras de mercado/loja disponíveis nos dados.
- na primeira execução sem catálogo anterior, o fallback fixo é apenas uma contingência; a preferência é sempre a coleta real da API.

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
- `scraper/fetch-media.js`: coleta (melhor esforço) de avaliações reais e vídeo dos produtos publicados.
- `product-media.json`: avaliações + vídeo por `itemId` (lido pelo site) e `diagnostics` da coleta.
- `logo-sm.png` / `notif-icon.png`: versões leves da logo (nav) e do ícone usado nas notificações. `logo.png` (1,8 MB) foi mantida como original.

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


## Regras atuais do catálogo

- Preço mínimo: **R$ 10,00**, usando `priceMin` da oferta. Produtos com qualquer variação abaixo desse piso ficam fora.
- Qualidade: somente produtos com avaliação informada e **4,5 estrelas ou mais**.
- Mercado: somente links `shopee.com.br`; o filtro de loja aceita tipos Official/Preferred/Preferred Plus (`shopType` 1/2/4) e bloqueia nomes explicitamente internacionais/importadores. A Open API não fornece um campo universal de país/origem do estoque, então essa política é conservadora, mas não é prova física de nacionalidade do estoque.
- Tendências: keywords dedicadas para produtos virais de vídeo/comércio (Kemei 3 em 1, fone invisível Q10, mini impressora térmica, mini seladora, kits de café da manhã, moda viral, utilidades, beleza e acessórios). Esses termos só descobrem candidatos; o filtro de qualidade continua valendo.
- Comissão: continuam sendo reservadas vagas para 10%–19,99%, 20%–29,99% e 30%+, sem deixar comissão superar a qualidade do produto.
- Repetição: o mesmo `itemId` não repete; ofertas equivalentes de lojas diferentes competem por preço, e a mais barata é a única publicada quando a equivalência é confirmada.
