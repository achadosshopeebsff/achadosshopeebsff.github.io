# Achados Shopee BSF — catálogo fixo + atualização automática

Este projeto **não faz busca por palavra-chave** e não cria links para páginas de pesquisa.

O catálogo é composto pelos produtos definidos em `fixed-products.json`. Cada item possui:

- Item ID
- Shop ID (extraído do `productLink`)
- nome/preço/vendas/comissão de referência
- `productLink` direto do item
- `offerLink` **de afiliado já fornecido**

A cada hora, o GitHub Actions consulta `productOfferV2` **diretamente por `shopId + itemId`** para atualizar apenas os dados daquele mesmo produto, incluindo imagem, preço, vendas, avaliação, comissão e nome da loja.

O bot **preserva o `offerLink` fixo de cada produto**. Ele nunca substitui o link por `shopee.com.br/search?...` e nunca cria um link de pesquisa.

`links.json` contém apenas os `offerLink` de afiliado.

## Secrets do GitHub

Cadastre em `Settings → Secrets and variables → Actions`:

- `SHOPEE_APP_ID`
- `SHOPEE_APP_SECRET`

As credenciais nunca são gravadas nos arquivos públicos.

## Atualização

- Executa automaticamente de hora em hora.
- Também pode ser executado em `Actions → Atualizar produtos Shopee → Run workflow`.
- Se a Shopee falhar temporariamente, o catálogo anterior permanece publicado.
- O frontend lê `products.json` e não chama a API da Shopee diretamente.

A API oficial brasileira usa GraphQL em `https://open-api.affiliate.shopee.com.br/graphql` e o `productOfferV2` permite consultar um produto conhecido por `itemId` e `shopId`, retornando `imageUrl`, `priceMin`, `sales`, `ratingStar`, `commission`, `productLink` e `offerLink`.
