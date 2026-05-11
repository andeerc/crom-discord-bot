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

  async summarize(messages: string): Promise<string> {
    if (!this.apiKey) {
      return this.simpleSummarize(messages);
    }

    try {
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
                "Voce e um assistente que resume conversas de chat em portugues. Seja conciso e capture os principais pontos discutidos.",
            },
            {
              role: "user",
              content: `Resuma as seguintes mensagens:\n\n${messages}`,
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
      return this.simpleSummarize(messages);
    }
  }

  private simpleSummarize(messages: string): string {
    const lines = messages.split("\n").filter((line) => line.trim());
    const count = lines.length;

    if (count === 0) {
      return "Nenhuma mensagem encontrada para resumir.";
    }

    const preview = lines.slice(0, 5).join("\n");
    const remainder = count > 5 ? `\n\n... e mais ${count - 5} mensagens.` : "";

    return `Resumo simples (${count} mensagens):\n\n${preview}${remainder}`;
  }
}
