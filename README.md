# Discord Bot de Resumo com NestJS

Bot para Discord que resume mensagens de um canal usando a API da OpenCode e salva checkpoints em SQLite para fazer resumos incrementais.

## Funcionalidades

- Comando `/resumir` com filtro por horas e limite de mensagens.
- Atualizacao de status na mesma resposta do Discord enquanto o resumo e processado.
- Resumo incremental por canal: depois do primeiro resumo, o bot considera apenas mensagens novas.
- Persistencia em SQLite do historico de resumos e do ultimo `message_id` resumido por canal.
- Comando `/historico` para listar mensagens recentes sem chamar a IA.
- Fallback local simples quando `OPENCODE_API_KEY` nao estiver configurada ou a chamada externa falhar.

## Stack

- Node.js 24
- NestJS 10
- discord.js 14
- SQLite nativo via `node:sqlite`

## Estrutura

```text
src/
  app.module.ts
  discord/
    discord.module.ts
    discord.service.ts
  storage/
    storage.module.ts
    summary-store.service.ts
  summarizer/
    summarizer.module.ts
    summarizer.service.ts
data/
  summaries.sqlite
```

## Variaveis de ambiente

Copie `.env.example` para `.env` e preencha os valores.

| Variavel | Obrigatoria | Descricao | Default |
| --- | --- | --- | --- |
| `DISCORD_BOT_TOKEN` | sim | Token do bot no Discord Developer Portal | - |
| `OPENCODE_API_KEY` | nao | Chave da OpenCode usada em `https://opencode.ai/zen/v1/chat/completions` | - |
| `OPENCODE_API_BASE` | nao | Base da API da OpenCode | `https://opencode.ai/zen/v1` |
| `OPENCODE_MODEL` | nao | Modelo enviado no campo `model` da API | `minimax-m2.5-free` |
| `SQLITE_PATH` | nao | Caminho do banco SQLite local | `data/summaries.sqlite` |

## Instalacao

```bash
npm install
```

## Executar em desenvolvimento

```bash
npm run start:dev
```

## Build e producao

```bash
npm run build
npm run start:prod
```

## Como configurar o bot no Discord

1. Crie uma application no Discord Developer Portal.
2. Crie o bot e copie o token para `DISCORD_BOT_TOKEN`.
3. Em `Bot > Privileged Gateway Intents`, habilite `Message Content Intent`.
4. Convide o bot para o servidor com escopos `bot` e `applications.commands`.
5. Inicie o projeto.
6. No log, confirme que apareceram:

```text
Bot conectado como ...
Slash commands registrados na guild.
```

Observacao:

- O registro de slash commands hoje acontece na primeira guild carregada em `client.guilds.cache.first()`.

## Comandos do bot

### `/resumir`

Resume apenas mensagens novas do canal desde o ultimo resumo salvo no SQLite.

Opcoes:

- `horas`: janela de busca para tras. Minimo `1`, maximo `168`. Default `1`.
- `mensagens`: limite maximo de mensagens novas consideradas. Minimo `5`, maximo `100`. Default `50`.

Exemplos:

```text
/resumir horas:1 mensagens:50
/resumir horas:24 mensagens:100
/resumir mensagens:20
```

Fluxo:

1. O bot responde imediatamente com status.
2. Busca mensagens do canal.
3. Para no ultimo `message_id` ja resumido para aquele canal.
4. Monta o contexto.
5. Chama a OpenCode.
6. Salva resumo e checkpoint no SQLite.
7. Edita a mesma mensagem com o resultado final.

Se nao houver mensagens novas desde o ultimo resumo, o bot informa isso e nao chama a IA.

### `/historico`

Lista mensagens recentes do canal sem resumir.

Opcao:

- `mensagens`: minimo `5`, maximo `50`, default `20`.

## Como funciona o resumo incremental

O projeto salva dois tipos de dado:

- `summary_checkpoints`: ultimo resumo por canal
- `summaries`: historico completo dos resumos gerados

Campos principais persistidos:

- `channel_id`
- `guild_id`
- `from_message_id`
- `to_message_id`
- `from_timestamp`
- `to_timestamp`
- `message_count`
- `summary`

Fluxo incremental:

1. Primeira execucao no canal:
   o bot busca mensagens dentro da janela e do limite pedido.
2. Execucoes seguintes:
   o bot continua buscando do mais recente para tras, mas interrompe ao encontrar o ultimo `message_id` salvo no checkpoint.

Isso evita resumir repetidamente o mesmo conteudo para pessoas diferentes no mesmo canal.

## OpenCode

O resumo usa chamada HTTP direta para:

```text
POST https://opencode.ai/zen/v1/chat/completions
```

Corpo relevante:

```json
{
  "model": "minimax-m2.5-free",
  "max_tokens": 8192,
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

Se `OPENCODE_API_KEY` nao estiver definida, o app retorna um resumo simples local apenas com preview das mensagens.

## Banco SQLite

Por padrao o banco fica em:

```text
data/summaries.sqlite
```

Para inspecionar localmente:

```bash
sqlite3 data/summaries.sqlite
```

Tabelas:

```sql
.tables
SELECT * FROM summary_checkpoints;
SELECT id, channel_id, message_count, created_at FROM summaries ORDER BY id DESC;
```

## Observacoes operacionais

- O bot ignora mensagens de outros bots.
- O bot ignora mensagens vazias no resumo incremental.
- O nome usado no contexto do resumo prioriza apelido no servidor (`displayName`), depois `globalName`, depois `username`.
- O status do `/resumir` e atualizado sempre na mesma resposta da interacao.

## Arquivos importantes

- [src/discord/discord.service.ts](./src/discord/discord.service.ts): comandos do Discord, coleta de mensagens e progresso da interacao.
- [src/summarizer/summarizer.service.ts](./src/summarizer/summarizer.service.ts): integracao com a OpenCode.
- [src/storage/summary-store.service.ts](./src/storage/summary-store.service.ts): SQLite, checkpoints e historico.

## Riscos e proximos ajustes

- O registro de comandos por `guilds.cache.first()` funciona para servidor de teste, mas e fragil para multi-guild. O ideal e registrar por `DISCORD_GUILD_ID`.
- O filtro por janela de tempo ainda depende da leitura paginada recente do canal; para canais muito movimentados, o limite de mensagens continua mandando no volume maximo analisado.
- O projeto nao tem testes automatizados ainda.
