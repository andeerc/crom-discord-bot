import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
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
  private client: Client;
  private startupSyncHours: number;
  private startupSyncMaxMessagesPerChannel: number;

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
    this.startupSyncHours = Number(
      this.config.get("STARTUP_SYNC_HOURS") || 12,
    );
    this.startupSyncMaxMessagesPerChannel = Number(
      this.config.get("STARTUP_SYNC_MAX_MESSAGES_PER_CHANNEL") || 500,
    );
  }

  async onModuleInit() {
    const token = this.config.get("DISCORD_BOT_TOKEN");
    if (!token) {
      console.error("DISCORD_BOT_TOKEN nao configurado.");
      return;
    }

    this.client.once("clientReady", async () => {
      console.log(`Bot conectado como ${this.client.user?.tag}`);
      await this.registerCommandsForAllGuilds();
      await this.syncRecentMessagesOnStartup();
    });

    this.client.on("guildCreate", async (guild) => {
      try {
        await this.registerCommandsForGuild(guild);
      } catch (error) {
        console.error(
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
        console.error("Erro ao processar comando:", error);

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
      } catch (error) {
        console.error("Erro ao persistir mensagem do canal:", error);
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
    const checkpoint = this.summaryStore.getCheckpoint(channel.id);
    const latestSummary = this.summaryStore.getLatestSummary(channel.id);

    await interaction.deferReply();
    await interaction.editReply(this.renderProgress("Buscando mensagens do canal"));

    try {
      this.assertReadableChannel(interaction);

      const messages = await this.fetchMessages(
        channel,
        hoursAgo,
        limit,
        checkpoint?.lastMessageId || null,
      );

      if (messages.length === 0) {
        await interaction.editReply(
          this.renderFailure(
            checkpoint?.lastMessageId
              ? "Nenhuma mensagem nova desde o ultimo resumo."
              : "Nenhuma mensagem encontrada no periodo especificado.",
          ),
        );
        return;
      }

      await interaction.editReply(
        this.renderProgress(
          `Encontrei ${messages.length} mensagens novas. Preparando contexto`,
        ),
      );

      const formattedMessages = messages
        .map((message) => `[${message.author}]: ${message.content}`)
        .join("\n");

      await interaction.editReply(
        this.renderProgress("Gerando resumo com OpenCode"),
      );

      const summary = await this.summarizer.summarize(
        formattedMessages,
        latestSummary?.summary || null,
      );

      this.summaryStore.saveSummary({
        channelId: channel.id,
        guildId: interaction.guildId || null,
        fromMessageId: checkpoint?.lastMessageId || null,
        toMessageId: messages[messages.length - 1].id,
        fromTimestamp: messages[0].timestamp.toISOString(),
        toTimestamp: messages[messages.length - 1].timestamp.toISOString(),
        messageCount: messages.length,
        summary,
      });

      await interaction.editReply(
        this.renderSummary(
          summary,
          hoursAgo,
          messages.length,
          checkpoint?.lastMessageId ? true : false,
        ),
      );
    } catch (error) {
      console.error("Erro ao resumir:", error);
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
      console.error("Erro ao buscar historico:", error);
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
      const contextMessages = this.getMentionContextMessages(
        message.channelId,
        prompt,
      );
      const formattedContext = this.formatStoredMessages(contextMessages);
      const answer = await this.summarizer.answerMention(
        prompt,
        formattedContext,
        latestSummary?.summary || null,
      );

      const finalReply = await loadingReply.edit(answer);
      this.summaryStore.saveMessages([this.toStoredMessageInput(finalReply)]);
    } catch (error) {
      console.error("Erro ao responder mencao:", error);
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
      console.warn("Nenhuma guild disponivel para registrar comandos.");
      return;
    }

    for (const guild of guilds) {
      await this.registerCommandsForGuild(guild);
    }
  }

  private async registerCommandsForGuild(guild: Guild) {
    const commands = this.getCommands();

    await guild.commands.set(commands);
    console.log(`Slash commands registrados na guild ${guild.id}.`);
  }

  private async syncRecentMessagesOnStartup() {
    const guilds = Array.from(this.client.guilds.cache.values());

    for (const guild of guilds) {
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
        console.error(
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
    let before: string | undefined;
    let synced = 0;

    try {
      while (synced < this.startupSyncMaxMessagesPerChannel) {
        const remaining = this.startupSyncMaxMessagesPerChannel - synced;
        const fetched = await channel.messages.fetch({
          limit: Math.min(100, remaining),
          before,
        });

        if (fetched.size === 0) {
          break;
        }

        const batch = Array.from(fetched.values()) as any[];
        batch.sort(
          (left, right) => left.createdTimestamp - right.createdTimestamp,
        );

        for (const message of batch) {
          if (message.createdAt < cutoff) {
            continue;
          }

          if (message.author.bot || !message.content.trim()) {
            continue;
          }

          storedMessages.push(this.toStoredMessageInput(message));
          synced += 1;

          if (synced >= this.startupSyncMaxMessagesPerChannel) {
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

      this.summaryStore.saveMessages(storedMessages);
    } catch (error) {
      console.error(
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

  private getMentionContextMessages(
    channelId: string,
    prompt: string,
  ): StoredMessage[] {
    const sinceIso = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recentMessages = this.summaryStore.getStoredMessages(
      channelId,
      sinceIso,
      150,
    );
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
            authorDisplayName:
              msg.member?.displayName ||
              msg.author.globalName ||
              msg.author.username,
            content: msg.content,
            author:
              msg.member?.displayName ||
              msg.author.globalName ||
              msg.author.username,
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
      console.error("Erro ao buscar mensagens:", error);
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

  private toStoredMessageInput(message: any) {
    return {
      guildId: message.guildId || null,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      authorUsername: message.author.username,
      authorDisplayName:
        message.member?.displayName ||
        message.author.globalName ||
        message.author.username,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    };
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
