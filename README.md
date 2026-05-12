# Discord Bot de Resumo com NestJS

Bot para Discord que resume mensagens de um canal usando a API da OpenCode, guarda memoria recente em SQLite e responde tanto por slash command quanto por `@mencao`.

## Funcionalidades

- Comando `/resumir` com filtro por horas e limite de mensagens.
- Atualizacao de status na mesma resposta do Discord enquanto o resumo e processado.
- Resumo incremental por canal: depois do primeiro resumo, o bot considera apenas mensagens novas.
- Persistencia em SQLite do historico de resumos, do ultimo `message_id` resumido por canal e das mensagens dos ultimos 3 dias.
- Sincronizacao inicial no startup para puxar pelo menos as ultimas 12 horas de mensagens dos canais acessiveis.
- Resposta por `@mencao` ao bot com uso do contexto recente do canal e do ultimo resumo salvo.
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
| `MESSAGE_RETENTION_DAYS` | nao | Quantos dias de mensagens recentes ficam no SQLite | `3` |
| `STARTUP_SYNC_HOURS` | nao | Quantas horas o bot tenta hidratar no startup | `12` |
| `STARTUP_SYNC_MAX_MESSAGES_PER_CHANNEL` | nao | Limite de mensagens sincronizadas por canal no startup | `500` |

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
Slash commands registrados na guild <id>.
```

Observacao:

- O bot registra slash commands em todas as guilds carregadas no startup.
- Quando entra em uma guild nova, registra automaticamente os comandos nela.

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

### `@bot ...`

Quando um usuario menciona o bot em um canal, ele responde como assistente usando:

- mensagens salvas no SQLite dos ultimos 3 dias
- filtro heuristico para puxar mensagens mais relevantes para o pedido
- ultimo resumo salvo do canal, quando existir

Exemplos:

```text
@bot me resume o que estavam falando hoje
@bot o que o Joao falou sobre deploy?
@bot me atualiza do que mudou desde ontem
```

Comportamento:

1. O bot salva a mensagem do usuario no SQLite.
2. Remove a mencao do texto e trata o resto como prompt.
3. Busca contexto recente do mesmo canal.
4. Tenta filtrar mensagens mais relevantes pelos termos do pedido.
5. Envia contexto + ultimo resumo do canal para a OpenCode.
6. Responde no proprio canal.
7. Salva a resposta final dele tambem no SQLite.

## Como funciona o resumo incremental

O projeto salva dois tipos de dado:

- `summary_checkpoints`: ultimo resumo por canal
- `summaries`: historico completo dos resumos gerados
- `channel_messages`: memoria recente de mensagens por canal

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

## Memoria de mensagens

O bot tambem guarda mensagens recentes em SQLite para sustentar o modo conversacional por `@mencao`.

Campos principais persistidos em `channel_messages`:

- `message_id`
- `guild_id`
- `channel_id`
- `author_id`
- `author_username`
- `author_display_name`
- `content`
- `created_at`

Politica atual:

- mensagens de bots sao ignoradas
- mensagens vazias sao ignoradas
- a retencao padrao e de 3 dias
- o armazenamento usa upsert por `message_id`
- no startup, o bot tenta hidratar pelo menos as ultimas 12 horas dos canais acessiveis

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
SELECT channel_id, author_display_name, created_at FROM channel_messages ORDER BY created_at DESC LIMIT 20;
```

## Observacoes operacionais

- O bot ignora mensagens de outros bots.
- O bot ignora mensagens vazias no resumo incremental.
- O nome usado no contexto do resumo prioriza apelido no servidor (`displayName`), depois `globalName`, depois `username`.
- O status do `/resumir` e atualizado sempre na mesma resposta da interacao.
- O modo `@mencao` depende da memoria local do SQLite e de um filtro heuristico simples por termos.
- Se o canal tiver pouco contexto salvo, a resposta por mencao pode ficar mais generica.
- O bot precisa de `View Channel` e `Read Message History` para ler e hidratar canais.

## Arquivos importantes

- [src/discord/discord.service.ts](./src/discord/discord.service.ts): comandos do Discord, coleta de mensagens e progresso da interacao.
- [src/summarizer/summarizer.service.ts](./src/summarizer/summarizer.service.ts): integracao com a OpenCode.
- [src/storage/summary-store.service.ts](./src/storage/summary-store.service.ts): SQLite, checkpoints e historico.

## Riscos e proximos ajustes

- O filtro de relevancia do modo `@mencao` ainda e heuristico; nomes ambiguos e pedidos muito amplos ainda podem puxar contexto ruim.
- O startup sync pode ficar caro em servidores com muitos canais acessiveis; por isso existe limite por canal.
- O filtro por janela de tempo ainda depende da leitura paginada recente do canal; para canais muito movimentados, o limite de mensagens continua mandando no volume maximo analisado.
- O projeto nao tem testes automatizados ainda.
