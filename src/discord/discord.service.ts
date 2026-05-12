import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Guild,
  PermissionFlagsBits,
  TextBasedChannel,
} from "discord.js";
import { SummaryStoreService } from "src/storage/summary-store.service";
import { SummarizerService } from "src/summarizer/summarizer.service";

type FetchedMessage = {
  id: string;
  content: string;
  author: string;
  timestamp: Date;
};

@Injectable()
export class DiscordService implements OnModuleInit, OnModuleDestroy {
  private client: Client;

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

      const summary = await this.summarizer.summarize(formattedMessages);

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
            content: msg.content,
            author:
              msg.member?.displayName ||
              msg.author.globalName ||
              msg.author.username,
            timestamp: msg.createdAt,
          });

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

    return messages.sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    );
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
