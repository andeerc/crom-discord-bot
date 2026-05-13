import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Guild,
  Message,
  PermissionFlagsBits,
  TextBasedChannel,
} from "discord.js";
import { StoredMessage, SummaryStoreService } from "src/storage/summary-store.service";
import { SummarizerService } from "src/summarizer/summarizer.service";

const DISCORD_MESSAGE_MAX_LENGTH = 2000;

type FetchedMessage = {
  id: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  content: string;
  author: string;
  timestamp: Date;
};

@Injectable()
export class DiscordService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordService.name);
  private client: Client;
  private startupSyncHours: number;
  private startupSyncMaxMessagesPerChannel: number;
  private mentionContextHours: number;
  private summarizePromptMaxChars: number;
  private mentionPromptMaxChars: number;

  constructor(
    private config: ConfigService,
    private summaryStore: SummaryStoreService,
    private summarizer: SummarizerService,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    const retentionDays = Number(
      this.config.get("MESSAGE_RETENTION_DAYS") || 3,
    );
    this.startupSyncHours = Number(
      this.config.get("STARTUP_SYNC_HOURS") || retentionDays * 24,
    );
    this.startupSyncMaxMessagesPerChannel = Number(
      this.config.get("STARTUP_SYNC_MAX_MESSAGES_PER_CHANNEL") || 500,
    );
    this.mentionContextHours = Number(
      this.config.get("MENTION_CONTEXT_HOURS") || 6,
    );
    this.summarizePromptMaxChars = Number(
      this.config.get("SUMMARIZE_PROMPT_MAX_CHARS") || 12000,
    );
    this.mentionPromptMaxChars = Number(
      this.config.get("MENTION_PROMPT_MAX_CHARS") || 10000,
    );
  }

  async onModuleInit() {
    const token = this.config.get("DISCORD_BOT_TOKEN");
    if (!token) {
      this.logger.error("DISCORD_BOT_TOKEN nao configurado.");
      return;
    }

    this.client.once("clientReady", async () => {
      this.logger.log(`Bot conectado como ${this.client.user?.tag}`);
      await this.registerCommandsForAllGuilds();
      await this.syncRecentMessagesOnStartup();
    });

    this.client.on("guildCreate", async (guild) => {
      try {
        await this.registerCommandsForGuild(guild);
      } catch (error) {
        this.logger.error(
          `Erro ao registrar comandos na nova guild ${guild.id}:`,
          error,
        );
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      try {
        await this.handleCommand(interaction);
      } catch (error) {
        this.logger.error("Erro ao processar comando:", error);

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("Erro ao processar comando.");
          return;
        }

        await interaction.reply({
          content: "Erro ao processar comando.",
          ephemeral: true,
        });
      }
    });

    this.client.on("messageCreate", async (message) => {
      if (!message.inGuild() || message.author.bot || !message.content.trim()) {
        return;
      }

      try {
        this.summaryStore.saveMessages([
          this.toStoredMessageInput(message),
        ]);
        this.logger.log(`Mensagem ingerida em tempo real no canal ${message.channelId}: ${message.id}`);
        this.summaryStore.upsertIngestCheckpoint(
          message.channelId,
          message.guildId || null,
          message.id,
          message.createdAt.toISOString(),
        );
        this.logger.log(`Checkpoint em tempo real atualizado no canal ${message.channelId}: ${message.id}`);
      } catch (error) {
        this.logger.error("Erro ao persistir mensagem do canal:", error);
      }

      if (this.isBotMention(message)) {
        await this.handleMention(message);
      }
    });

    await this.client.login(token);
  }

  async onModuleDestroy() {
    this.client.destroy();
  }

  private async handleCommand(interaction: any) {
    const { commandName } = interaction;

    if (commandName === "resumir") {
      await this.handleSummarize(interaction);
      return;
    }

    if (commandName === "historico") {
      await this.handleHistory(interaction);
    }
  }

  private async handleSummarize(interaction: any) {
    const channel = interaction.channel;
    const options = interaction.options;
    const hoursAgo = options.getInteger("horas") || 1;
    const limit = options.getInteger("mensagens") || 50;
    const latestSummary = this.summaryStore.getLatestSummary(channel.id);

    await interaction.deferReply();
    await interaction.editReply(this.renderProgress("Buscando mensagens do canal"));

    try {
      this.assertReadableChannel(interaction);

      const messages = await this.fetchMessages(channel, hoursAgo, limit, null);

      if (messages.length === 0) {
        await interaction.editReply(
          this.renderFailure("Nenhuma mensagem encontrada no periodo especificado."),
        );
        return;
      }

      await interaction.editReply(
        this.renderProgress(
          `Encontrei ${messages.length} mensagens. Preparando contexto`,
        ),
      );

      const formattedMessages = messages
        .map((message) => `[${message.author}]: ${message.content}`)
        .join("\n");
      const messageChunks = this.splitContextIntoChunks(
        formattedMessages,
        this.summarizePromptMaxChars,
      );

      await interaction.editReply(
        this.renderProgress(`Gerando resumo com OpenCode (${messageChunks.length} parte(s))`),
      );

      const partialSummaries: string[] = [];

      for (let index = 0; index < messageChunks.length; index += 1) {
        const summaryPart = await this.summarizer.summarize(
          messageChunks[index],
          index === 0 ? latestSummary?.summary || null : null,
        );
        partialSummaries.push(summaryPart);
      }

      const summary =
        partialSummaries.length === 1
          ? partialSummaries[0]
          : await this.summarizer.mergeSummaries(
              partialSummaries,
              latestSummary?.summary || null,
            );

      this.summaryStore.saveSummary({
        channelId: channel.id,
        guildId: interaction.guildId || null,
        fromMessageId: messages[0]?.id || null,
        toMessageId: messages[messages.length - 1].id,
        fromTimestamp: messages[0].timestamp.toISOString(),
        toTimestamp: messages[messages.length - 1].timestamp.toISOString(),
        messageCount: messages.length,
        summary,
      });

      await this.replyWithChunks(
        interaction,
        this.renderSummary(
          summary,
          hoursAgo,
          messages.length,
          false,
        ),
      );
    } catch (error) {
      this.logger.error("Erro ao resumir:", error);
      await interaction.editReply(
        this.renderFailure(this.getUserFacingError(error)),
      );
    }
  }

  private async handleHistory(interaction: any) {
    const channel = interaction.channel;
    const limit = interaction.options.getInteger("mensagens") || 20;

    await interaction.deferReply();

    try {
      this.assertReadableChannel(interaction);

      const messages = await this.fetchMessages(channel, 24, limit, null);
      const history = messages
        .map(
          (message) =>
            `**${message.author}** (${message.timestamp.toLocaleString("pt-BR")}):\n${message.content}`,
        )
        .join("\n\n---\n\n");

      await interaction.editReply(history || "Nenhuma mensagem encontrada.");
    } catch (error) {
      this.logger.error("Erro ao buscar historico:", error);
      await interaction.editReply(this.getUserFacingError(error));
    }
  }

  private async handleMention(message: Message) {
    const prompt = this.stripBotMention(message.content).trim();

    if (!prompt) {
      await message.reply("Mande a pergunta junto com a mencao.");
      return;
    }

    const loadingReply = await message.reply("Pensando...");

    try {
      const latestSummary = this.summaryStore.getLatestSummary(message.channelId);
      const contextMessages = await this.getMentionContextMessages(
        message,
        prompt,
      );
      const formattedContext = this.formatStoredMessages(contextMessages);
      const contextChunks = this.splitContextIntoChunks(
        formattedContext,
        this.mentionPromptMaxChars,
      );
      const partialAnswers: string[] = [];

      for (const chunk of contextChunks) {
        const partialAnswer = await this.summarizer.answerMention(
          prompt,
          chunk,
          latestSummary?.summary || null,
        );
        partialAnswers.push(partialAnswer);
      }

      const answer =
        partialAnswers.length === 1
          ? partialAnswers[0]
          : await this.summarizer.mergeMentionAnswers(
              prompt,
              partialAnswers,
              latestSummary?.summary || null,
            );

      const finalReply = await loadingReply.edit(answer);
      this.summaryStore.saveMessages([this.toStoredMessageInput(finalReply)]);
    } catch (error) {
      this.logger.error("Erro ao responder mencao:", error);
      await loadingReply.edit(this.getUserFacingError(error));
    }
  }

  private getCommands() {
    return [
      {
        name: "resumir",
        description: "Resume mensagens novas do canal",
        options: [
          {
            name: "horas",
            type: 4,
            description: "Quantas horas atras olhar",
            required: false,
            min_value: 1,
            max_value: 168,
          },
          {
            name: "mensagens",
            type: 4,
            description: "Limite maximo de mensagens novas",
            required: false,
            min_value: 5,
            max_value: 100,
          },
        ],
      },
      {
        name: "historico",
        description: "Mostra o historico de mensagens",
        options: [
          {
            name: "mensagens",
            type: 4,
            description: "Numero de mensagens para mostrar",
            required: false,
            min_value: 5,
            max_value: 50,
          },
        ],
      },
    ];
  }

  private async registerCommandsForAllGuilds() {
    const guilds = Array.from(this.client.guilds.cache.values());

    if (guilds.length === 0) {
      this.logger.warn("Nenhuma guild disponivel para registrar comandos.");
      return;
    }

    for (const guild of guilds) {
      await this.registerCommandsForGuild(guild);
    }
  }

  private async registerCommandsForGuild(guild: Guild) {
    const commands = this.getCommands();

    await guild.commands.set(commands);
    this.logger.log(`Slash commands registrados na guild ${guild.id}.`);
  }

  private async syncRecentMessagesOnStartup() {
    const guilds = Array.from(this.client.guilds.cache.values());
    this.logger.log(`Iniciando sync de startup em ${guilds.length} guild(s).`);

    for (const guild of guilds) {
      this.logger.log(`Sync startup: guild ${guild.id}`);
      try {
        await guild.channels.fetch();
        const channels = Array.from(guild.channels.cache.values());

        for (const channel of channels) {
          if (!this.canSyncChannel(channel)) {
            continue;
          }

          await this.syncChannelRecentMessages(channel);
        }
      } catch (error) {
        this.logger.error(
          `Erro ao sincronizar mensagens no startup da guild ${guild.id}:`,
          error,
        );
      }
    }
  }

  private canSyncChannel(channel: any): boolean {
    const botUser = this.client.user;

    if (!botUser || !channel) {
      return false;
    }

    if (typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
      return false;
    }

    if (!("messages" in channel) || typeof channel.permissionsFor !== "function") {
      return false;
    }

    const permissions = channel.permissionsFor(botUser);
    return !!(
      permissions &&
      permissions.has(PermissionFlagsBits.ViewChannel) &&
      permissions.has(PermissionFlagsBits.ReadMessageHistory)
    );
  }

  private async syncChannelRecentMessages(channel: any) {
    const cutoff = new Date(
      Date.now() - this.startupSyncHours * 60 * 60 * 1000,
    );
    const storedMessages = [];
    const checkpoint = this.summaryStore.getIngestCheckpoint(channel.id);
    this.logger.log(`Sync startup: canal ${channel.id} | checkpoint=${checkpoint?.lastMessageId || "nenhum"} | janela=${this.startupSyncHours}h`);
    const checkpointId = checkpoint?.lastMessageId
      ? BigInt(checkpoint.lastMessageId)
      : null;
    let synced = 0;
    let newestSeenMessage: any | null = null;
    let cursorBefore: string | undefined;

    try {
      while (synced < this.startupSyncMaxMessagesPerChannel) {
        const remaining = this.startupSyncMaxMessagesPerChannel - synced;
        const fetched = await channel.messages.fetch({
          limit: Math.min(100, remaining),
          ...(cursorBefore ? { before: cursorBefore } : {}),
        });

        if (fetched.size === 0) {
          this.logger.log(`Sync startup: canal ${channel.id} sem mais mensagens para paginação.`);
          break;
        }

        const batch = Array.from(fetched.values()) as any[];
        batch.sort(
          (left, right) => left.createdTimestamp - right.createdTimestamp,
        );

        let reachedCheckpoint = false;
        let reachedCutoff = false;

        for (const message of batch) {
          if (checkpointId && BigInt(message.id) <= checkpointId) {
            reachedCheckpoint = true;
            continue;
          }

          if (message.createdAt < cutoff) {
            reachedCutoff = true;
            continue;
          }

          if (message.author.bot || !message.content.trim()) {
            continue;
          }

          storedMessages.push(this.toStoredMessageInput(message));

          if (!newestSeenMessage) {
            newestSeenMessage = message;
          }

          synced += 1;

          if (synced >= this.startupSyncMaxMessagesPerChannel) {
            break;
          }
        }

        const oldest = batch[0];
        if (!oldest || reachedCheckpoint || reachedCutoff) {
          if (reachedCheckpoint) {
            this.logger.log(`Sync startup: canal ${channel.id} parou ao atingir checkpoint.`);
          }

          if (reachedCutoff) {
            this.logger.log(`Sync startup: canal ${channel.id} parou ao atingir cutoff da janela.`);
          }

          break;
        }

        cursorBefore = oldest.id;
      }

      this.summaryStore.saveMessages(storedMessages);

      this.logger.log(`Sync startup: canal ${channel.id} persistiu ${storedMessages.length} mensagem(ns).`);

      if (newestSeenMessage) {
        this.summaryStore.upsertIngestCheckpoint(
          channel.id,
          channel.guild?.id || null,
          newestSeenMessage.id,
          newestSeenMessage.createdAt?.toISOString?.() || null,
        );
        this.logger.log(`Sync startup: checkpoint atualizado no canal ${channel.id} para ${newestSeenMessage.id}.`);
      }
    } catch (error) {
      this.logger.error(
        `Erro ao sincronizar mensagens do canal ${channel.id} no startup:`,
        error,
      );
    }
  }

  private isBotMention(message: Message): boolean {
    const botUser = this.client.user;

    if (!botUser) {
      return false;
    }

    return message.mentions.users.has(botUser.id);
  }

  private stripBotMention(content: string): string {
    const botUser = this.client.user;

    if (!botUser) {
      return content;
    }

    const mentionRegex = new RegExp(`<@!?${botUser.id}>`, "g");
    return content.replace(mentionRegex, "").trim();
  }

  private async getMentionContextMessages(
    message: Message,
    prompt: string,
  ): Promise<StoredMessage[]> {
    const sinceIso = new Date(
      Date.now() - this.mentionContextHours * 60 * 60 * 1000,
    ).toISOString();
    let recentMessages = this.summaryStore.getStoredMessages(
      message.channelId,
      sinceIso,
      150,
    );

    if (recentMessages.length < 20) {
      const fetchedMessages = await this.fetchMessages(
        message.channel,
        this.mentionContextHours,
        150,
        null,
      );

      if (fetchedMessages.length > 0) {
        recentMessages = this.summaryStore.getStoredMessages(
          message.channelId,
          sinceIso,
          150,
        );
      }
    }

    const botUserId = this.client.user?.id;
    if (botUserId) {
      recentMessages = recentMessages.filter((storedMessage) => storedMessage.authorId !== botUserId);
    }

    if (recentMessages.length === 0) {
      return [];
    }

    const relevantMessages = this.filterRelevantMessages(recentMessages, prompt);

    if (relevantMessages.length > 0) {
      return relevantMessages.slice(-80);
    }

    return recentMessages.slice(-80);
  }

  private filterRelevantMessages(
    messages: StoredMessage[],
    prompt: string,
  ): StoredMessage[] {
    const tokens = prompt
      .toLowerCase()
      .split(/[^a-z0-9_@-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
      .filter((token) => !this.isStopWord(token));

    if (tokens.length === 0) {
      return [];
    }

    return messages.filter((message) => {
      const haystack = [
        message.authorDisplayName,
        message.authorUsername,
        message.content,
      ]
        .join(" ")
        .toLowerCase();

      return tokens.some((token) => haystack.includes(token));
    });
  }

  private isStopWord(token: string): boolean {
    return new Set([
      "que",
      "como",
      "para",
      "com",
      "por",
      "uma",
      "umas",
      "dos",
      "das",
      "nos",
      "nas",
      "sobre",
      "bot",
      "me",
      "de",
      "da",
      "do",
      "um",
      "uma",
      "ele",
      "ela",
      "isso",
      "esse",
      "essa",
      "esta",
      "este",
      "estao",
      "qual",
      "quais",
      "fale",
      "fala",
      "resuma",
      "resumo",
    ]).has(token);
  }

  private formatStoredMessages(messages: StoredMessage[]): string {
    return messages
      .map((message) => {
        const timestamp = new Date(message.createdAt).toLocaleString("pt-BR");
        return `[${timestamp}] ${message.authorDisplayName}: ${message.content}`;
      })
      .join("\n");
  }

  private assertReadableChannel(interaction: any) {
    const channel = interaction.channel;
    const botUser = this.client.user;

    if (!channel || channel.type === ChannelType.DM || !botUser) {
      throw new Error("Canal invalido para leitura de mensagens.");
    }

    if (typeof channel.permissionsFor !== "function") {
      throw new Error("Canal nao suporta leitura de mensagens.");
    }

    const permissions = channel.permissionsFor(botUser);

    if (
      !permissions ||
      !permissions.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.ReadMessageHistory)
    ) {
      throw new Error(
        "Bot sem permissao para ver o canal ou ler o historico de mensagens.",
      );
    }
  }

  private async fetchMessages(
    channel: TextBasedChannel,
    hoursAgo: number,
    limit: number,
    lastSummarizedMessageId: string | null,
  ): Promise<FetchedMessage[]> {
    const messages: FetchedMessage[] = [];
    const storedMessages = [];
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    const checkpointId = lastSummarizedMessageId
      ? BigInt(lastSummarizedMessageId)
      : null;
    let before: string | undefined;
    let reachedCheckpoint = false;

    try {
      while (messages.length < limit && !reachedCheckpoint) {
        const fetched = await channel.messages.fetch({
          limit: Math.min(100, limit),
          before,
        });

        if (fetched.size === 0) {
          this.logger.log(`Sync startup: canal ${channel.id} sem mais mensagens para paginação.`);
          break;
        }

        const batch = Array.from(fetched.values()).sort(
          (left, right) => left.createdTimestamp - right.createdTimestamp,
        );

        for (const msg of batch) {
          if (checkpointId && BigInt(msg.id) <= checkpointId) {
            reachedCheckpoint = true;
            continue;
          }

          if (msg.createdAt < cutoff) {
            continue;
          }

          if (msg.author.bot || !msg.content.trim()) {
            continue;
          }

          messages.push({
            id: msg.id,
            authorId: msg.author.id,
            authorUsername: msg.author.username,
            authorDisplayName: this.resolveAuthorDisplayName(msg),
            content: msg.content,
            author: this.resolveAuthorDisplayName(msg),
            timestamp: msg.createdAt,
          });
          storedMessages.push(this.toStoredMessageInput(msg));

          if (messages.length >= limit) {
            break;
          }
        }

        const oldest = fetched.last();
        if (!oldest) {
          break;
        }

        before = oldest.id;

        if (oldest.createdAt < cutoff) {
          break;
        }
      }
    } catch (error) {
      this.logger.error("Erro ao buscar mensagens:", error);
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 50001
      ) {
        throw new Error(
          "Bot sem acesso a esse canal. Verifique as permissoes de View Channel e Read Message History.",
        );
      }

      throw error;
    }

    this.summaryStore.saveMessages(storedMessages);

    return messages.sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    );
  }


  private resolveAuthorDisplayName(message: any): string {
    const guildMemberDisplayName =
      message.guild?.members?.cache?.get(message.author.id)?.displayName;

    return (
      message.member?.displayName ||
      guildMemberDisplayName ||
      message.author.globalName ||
      message.author.username
    );
  }
  private toStoredMessageInput(message: any) {
    return {
      guildId: message.guildId || null,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      authorUsername: message.author.username,
      authorDisplayName: this.resolveAuthorDisplayName(message),
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    };
  }



  private splitContextIntoChunks(content: string, maxChars: number): string[] {
    if (content.length <= maxChars) {
      return [content];
    }

    const chunks: string[] = [];
    const lines = content.split("\n");
    let current = "";

    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;

      if (next.length <= maxChars) {
        current = next;
        continue;
      }

      if (current) {
        chunks.push(current);
      }

      if (line.length <= maxChars) {
        current = line;
        continue;
      }

      for (let start = 0; start < line.length; start += maxChars) {
        chunks.push(line.slice(start, start + maxChars));
      }

      current = "";
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  private async replyWithChunks(interaction: any, content: string) {
    const chunks = this.splitContentForDiscord(content, DISCORD_MESSAGE_MAX_LENGTH);

    if (chunks.length === 0) {
      await interaction.editReply(" ");
      return;
    }

    await interaction.editReply(chunks[0]);

    for (let index = 1; index < chunks.length; index += 1) {
      await interaction.followUp(chunks[index]);
    }
  }

  private splitContentForDiscord(content: string, maxChars: number): string[] {
    if (!content) {
      return [];
    }

    if (content.length <= maxChars) {
      return [content];
    }

    const chunks: string[] = [];
    const lines = content.split("\n");
    let current = "";

    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;

      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      if (current) {
        chunks.push(current);
      }

      if (line.length <= maxChars) {
        current = line;
        continue;
      }

      for (let start = 0; start < line.length; start += maxChars) {
        chunks.push(line.slice(start, start + maxChars));
      }

      current = "";
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  private truncateForPrompt(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
      return content;
    }

    const truncated = content.slice(content.length - maxChars);
    return `[contexto truncado para caber no limite de ${maxChars} caracteres]\n${truncated}`;
  }

  private getUserFacingError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return "Erro ao processar comando.";
  }

  private renderProgress(step: string): string {
    return ["Resumo", "", `Status: ${step}...`].join("\n");
  }

  private renderSummary(
    summary: string,
    hoursAgo: number,
    messageCount: number,
    usedCheckpoint: boolean,
  ): string {
    return [
      "Resumo",
      "",
      `Janela: ultimas ${hoursAgo}h`,
      `Mensagens novas: ${messageCount}`,
      `Modo: ${usedCheckpoint ? "incremental" : "completo"}`,
      "",
      summary,
    ].join("\n");
  }

  private renderFailure(reason: string): string {
    return ["Resumo", "", `Status: ${reason}`].join("\n");
  }
}
