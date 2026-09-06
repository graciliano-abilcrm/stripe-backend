# R1 — Aba "Visão Geral": corrigir o card "A Receber"

Mexer **somente** na aba **"Visão Geral"** (a que abre por padrão). Não tocar em
"Dashboard", "Repasses", "PagBank" nem em nenhuma outra aba nesta rodada.

## Problema

O card **"A Receber"** mostra `R$ 67.446,29` com o subtítulo "Valores a liberar
(Stripe + PagBank)", mas o gráfico de projeção da mesma tela somava `R$ 56.024,80`
só de Stripe. Card e gráfico se contradiziam. O backend já foi corrigido e agora
explica a diferença.

Além disso, no bloco **PagBank** o campo "Saldo Disponível" mostra
`🔒 Indisponível` sem dizer por quê.

## O que fazer

Endpoint (já no ar): `GET /api/projecao/recebimento`

**1. No card "A Receber"**, abaixo do valor total, mostrar três linhas usando o
objeto `reconciliacao` da resposta:

```
Bruto a liberar          reconciliacao.stripe_bruto_a_liberar
− Já virou repasse       reconciliacao.stripe_comprometido_em_repasse
= Pendente na Stripe     reconciliacao.stripe_pendente_liquido
```

Os valores mudam a cada nova cobrança — ler sempre da resposta, nunca fixar número.

Rotular esse bloco como "Stripe". O valor grande do card continua sendo
`total_pendente`. Só aparecer quando `reconciliacao.stripe_comprometido_em_repasse > 0`.

**2. No gráfico de projeção**, cada ponto de `projecao[]` tem: `data`, `data_br`,
`stripe`, `pagbank`, `total`, `atrasado`. Quando `atrasado === true`, pintar a
barra em âmbar e mostrar no tooltip "liberação atrasada". Não filtrar esses
pontos fora.

**3. No bloco PagBank**, trocar o texto `🔒 Indisponível` do "Saldo Disponível"
por um ícone de informação com tooltip. O texto do tooltip vem de
`GET /api/pagbank/saldo`, campo `disponivel_motivo`. Não inventar o texto.

## Proibições

- Não mudar layout, grid, cores de fundo ou tipografia do card.
- Não criar componente novo: editar o card que já existe.
- Não mexer no card "Receita Total Consolidada" nem no "Valor Recebido".
- Não procurar CSS: reusar as classes já aplicadas nas linhas internas do card.

## Verificação

Ao terminar, confirme: (a) arquivo e linha de cada alteração; (b) que abrir a
rota sem clicar em nada mostra a aba "Visão Geral" com as três linhas novas;
(c) que as tres linhas aparecem nessa ordem e que a subtracao fecha: o terceiro
valor e igual ao primeiro menos o segundo.
