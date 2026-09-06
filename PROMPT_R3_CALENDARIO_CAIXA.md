# R3 — Nova seção "Calendário de Caixa" na aba "Repasses"

Só rodar **depois** que o R2 estiver publicado e funcionando.

Mexer **somente** na aba **"Repasses"**, acrescentando uma seção no fim dela.
Não tocar nos 3 blocos criados no R2 nem em nenhuma outra aba.

## Objetivo

Responder de bate-pronto: **"quanto entra até sexta?"**

## O que fazer

Endpoint novo (já no ar): `GET /api/fluxo-caixa?dias=30`
(o parâmetro `dias` aceita de 1 a 180)

**1. Três números no topo da seção**, lado a lado, vindos de `resumo`:
- "Próximos 7 dias" → `resumo.ate_7_dias`
- "Próximos 15 dias" → `resumo.ate_15_dias`
- "Próximos 30 dias" → `resumo.ate_30_dias`

**2. Abaixo, uma tabela por dia** a partir de `calendario[]`, com as colunas:

| coluna | campo |
|---|---|
| Data | `data_br` |
| Dia | `dia_semana` (já vem "seg", "ter"…) |
| Libera Stripe | `stripe_liberando` |
| Libera PagBank | `pagbank_liberando` |
| Total do dia | `total_liberando` |
| Acumulado | `acumulado` |
| Chega no banco | `chegando_no_banco` |

Regras de exibição:
- Linha com `atrasado === true` → etiqueta âmbar "atrasado"
- Célula com valor `0` → mostrar "—", não "R$ 0,00"
- Linha com `chegando_no_banco > 0` → destacar (é o dia em que o dinheiro
  efetivamente cai no Santander)

**3. Um seletor de período** com as opções 7 / 15 / 30 / 60 dias, que refaz a
chamada trocando o `dias` da querystring.

## Proibições

- Não usar biblioteca de gráfico ou de calendário nova: tabela simples, com as
  classes de tabela que já existem na aba.
- Não criar aba nova nem item de menu.
- Não somar a coluna "Chega no banco" com "Total do dia" — são estágios
  diferentes do mesmo dinheiro.

## Verificação

Ao terminar, confirme: (a) arquivo e linha de cada alteração; (b) que a seção
aparece no fim da aba "Repasses"; (c) que os dias com `chegando_no_banco > 0`
aparecem destacados; (d) que trocar o seletor para 7
dias refaz a chamada com `?dias=7`.
