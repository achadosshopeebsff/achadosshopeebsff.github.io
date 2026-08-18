# achadosshopeebsf — catálogo automático Shopee

Este projeto é uma vitrine leve de achadinhos da Shopee. O navegador **não chama a API da Shopee**: o GitHub Actions roda um bot em background, gera `products.json` e o site apenas lê o JSON estático. Isso reduz travamentos e consumo de rede no celular.

## O que o bot faz automaticamente

1. Consulta a Shopee Affiliate Open API usando `productOfferV2`.
2. Faz várias buscas por palavras-chave e também consultas de produtos de melhor desempenho.
3. Coleta dezenas/centenas de candidatos.
4. Filtra por avaliação, vendas, preço e, opcionalmente, comissão.
5. Dá uma pontuação maior para produtos com boa avaliação, muitas vendas, desconto e preço baixo.
6. Remove duplicados.
7. Usa `offerLink` retornado pela API como link de afiliado. Quando um produto não traz `offerLink`, tenta `generateShortLink` apenas como fallback.
8. Publica os melhores produtos em `products.json`.
9. O `index.html` mostra automaticamente o catálogo novo sem cadastro manual de links.

A API oficial disponibiliza `productOfferV2` para buscar produtos e campos como `productName`, `offerLink`, `priceMin`, `priceMax`, `priceDiscountRate`, `sales`, `ratingStar` e `commissionRate`. O `offerLink` é o link da oferta de afiliado. Fonte: https://open-api.affiliate.shopee.com.br/explorer

## Configuração única no GitHub

Em **Settings → Secrets and variables → Actions**, crie:

- `SHOPEE_APP_ID`
- `SHOPEE_APP_SECRET`

Nunca coloque a Secret no `index.html`, `products.json`, JavaScript do frontend ou `bot-config.json`.

## Personalizar o bot

Edite somente `bot-config.json` quando quiser mudar o comportamento.

- `keywords`: assuntos/produtos que o bot deve buscar.
- `rules.minRating`: avaliação mínima.
- `rules.minSales`: vendas mínimas.
- `rules.minPrice` / `rules.maxPrice`: faixa de preço.
- `output.maxProducts`: quantidade publicada no site (até 500).
- `output.maxShortLinks`: limite de short links de fallback por execução.

Exemplo: para priorizar ainda mais produtos baratos e bem avaliados, mantenha `minRating` em `4.6` e `maxPrice` entre `100` e `200`.

## Atualização automática

O workflow executa a cada 5 minutos e também pode ser iniciado manualmente em **Actions → Atualizar achadinhos Shopee → Run workflow**. O navegador verifica o catálogo uma vez por minuto, sem chamar a Shopee diretamente.

O bot **nunca apaga um catálogo válido** quando a API retorna zero produtos ou sofre uma falha temporária. O pacote também inclui `fallback-products.json` e um catálogo inicial para a primeira publicação; esse catálogo inicial usa buscas públicas da Shopee e é substituído automaticamente pelos links de afiliado reais assim que a primeira sincronização bem-sucedida ocorrer.

Depois da execução, o bot atualiza `products.json`. O site continua rápido porque o visitante recebe somente o catálogo estático e as imagens carregam sob demanda.

## Importante

A seleção é automática, mas a API e a disponibilidade da Shopee determinam quais ofertas podem ser retornadas. O bot não inventa produtos nem links. Preços, estoque, promoções e disponibilidade podem mudar.
