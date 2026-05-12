import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SummarizerService {
  private apiKey?: string;
  private baseUrl: string;
  private model: string;

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get("OPENCODE_API_KEY");
    this.baseUrl =
      this.config.get("OPENCODE_API_BASE") || "https://opencode.ai/zen/v1";
    this.model = this.config.get("OPENCODE_MODEL") || "minimax-m2.5-free";
  }

  async summarize(
    messages: string,
    previousSummary: string | null = null,
  ): Promise<string> {
    if (!this.apiKey) {
      return this.simpleSummarize(messages, previousSummary);
    }

    try {
      const promptSections = [
        "Gere um resumo em portugues do Brasil com linguagem fluida e direta.",
        "Nao use listas numeradas como formato padrao.",
        "Use exatamente estas secoes, nesta ordem:",
        "Assunto da conversa",
        "Usuarios envolvidos",
        "Tom da conversa",
        "TL;DR",
        "Pontos altos",
      ];

      if (previousSummary) {
        promptSections.push(
          "",
          "Contexto anterior do canal:",
          previousSummary,
          "",
          "Continue a narrativa a partir desse resumo anterior.",
          "Nao repita o que ja estava resolvido antes, a menos que tenha mudado.",
        );
      }

      promptSections.push(
        "",
        "Novas mensagens para resumir:",
        messages,
      );

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          messages: [
            {
              role: "system",
              content:
                "Voce resume conversas de chat em portugues do Brasil. Sua resposta deve ser clara, fluida, curta quando possivel e organizada por secoes nomeadas.",
            },
            {
              role: "user",
              content: promptSections.join("\n"),
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenCode retornou ${response.status}: ${errorBody || response.statusText}`,
        );
      }

      const data = await response.json();
      const output = data.choices?.[0]?.message?.content?.trim();

      if (!output) {
        throw new Error("Resposta da OpenCode veio sem choices[0].message.content.");
      }

      return output;
    } catch (error) {
      console.error("Erro na API da OpenCode:", error);
      return this.simpleSummarize(messages, previousSummary);
    }
  }

  async answerMention(
    userPrompt: string,
    contextMessages: string,
    previousSummary: string | null = null,
  ): Promise<string> {
    if (!this.apiKey) {
      return this.simpleMentionReply(userPrompt, contextMessages, previousSummary);
    }

    try {
      const promptSections = [
        "Voce e um assistente de canal no Discord.",
        "Responda em portugues do Brasil.",
        "Use o contexto do canal abaixo para responder ao pedido do usuario.",
        "Se o usuario pedir um resumo, responda com texto natural e, quando fizer sentido, use secoes como:",
        "Assunto da conversa",
        "Usuarios envolvidos",
        "Tom da conversa",
        "TL;DR",
        "Pontos altos",
        "Se o usuario estiver conversando normalmente, responda de forma direta, sem forcar secoes.",
        "Se o contexto nao bastar, diga isso claramente.",
      ];

      if (previousSummary) {
        promptSections.push(
          "",
          "Ultimo resumo salvo do canal:",
          previousSummary,
        );
      }

      promptSections.push(
        "",
        "Memoria recente do canal:",
        contextMessages || "Sem memoria recente.",
        "",
        "Pedido do usuario:",
        userPrompt,
      );

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          messages: [
            {
              role: "system",
              content:
                "Voce atua como um assistente de conversa em canal Discord. Priorize resposta clara, objetiva e contextual.",
            },
            {
              role: "user",
              content: promptSections.join("\n"),
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenCode retornou ${response.status}: ${errorBody || response.statusText}`,
        );
      }

      const data = await response.json();
      const output = data.choices?.[0]?.message?.content?.trim();

      if (!output) {
        throw new Error("Resposta da OpenCode veio sem choices[0].message.content.");
      }

      return output;
    } catch (error) {
      console.error("Erro na API da OpenCode:", error);
      return this.simpleMentionReply(userPrompt, contextMessages, previousSummary);
    }
  }

  private simpleSummarize(
    messages: string,
    previousSummary: string | null = null,
  ): string {
    const lines = messages.split("\n").filter((line) => line.trim());
    const count = lines.length;

    if (count === 0) {
      return "Nenhuma mensagem encontrada para resumir.";
    }

    const users = Array.from(
      new Set(
        lines
          .map((line) => {
            const match = line.match(/^\[([^\]]+)\]:/);
            return match?.[1]?.trim() || null;
          })
          .filter(Boolean),
      ),
    ) as string[];

    const cleanedMessages = lines.map((line) =>
      line.replace(/^\[[^\]]+\]:\s*/, "").trim(),
    );
    const preview = cleanedMessages.slice(0, 5);
    const tone = this.detectTone(cleanedMessages);
    const previousContext = previousSummary
      ? "Este resumo continua um contexto anterior ja salvo no canal."
      : "Este resumo cobre apenas o lote atual de mensagens.";

    return [
      "Assunto da conversa",
      `Troca recente no canal com ${count} mensagens novas.`,
      "",
      "Usuarios envolvidos",
      users.length > 0 ? users.join(", ") : "Nao identificado",
      "",
      "Tom da conversa",
      tone,
      "",
      "TL;DR",
      `${previousContext} Os temas centrais apareceram nas mensagens mais recentes do canal.`,
      "",
      "Pontos altos",
      ...preview.map((message) => `- ${message}`),
      ...(count > preview.length
        ? [`- ... e mais ${count - preview.length} mensagens.`]
        : []),
    ].join("\n");
  }

  private detectTone(messages: string[]): string {
    const text = messages.join(" ").toLowerCase();

    if (/[!?]/.test(text)) {
      return "Agitado ou enfatico.";
    }

    if (
      text.includes("erro") ||
      text.includes("bug") ||
      text.includes("falha") ||
      text.includes("problema")
    ) {
      return "Tecnico e orientado a resolucao de problema.";
    }

    return "Neutro e objetivo.";
  }

  private simpleMentionReply(
    userPrompt: string,
    contextMessages: string,
    previousSummary: string | null = null,
  ): string {
    const lines = contextMessages.split("\n").filter((line) => line.trim());
    const preview = lines.slice(-6).join("\n");

    return [
      `Pedido: ${userPrompt}`,
      "",
      previousSummary ? "Resumo anterior encontrado no canal." : "Sem resumo anterior salvo.",
      "",
      "Contexto recente disponivel:",
      preview || "Sem mensagens recentes suficientes no banco local.",
    ].join("\n");
  }
}
