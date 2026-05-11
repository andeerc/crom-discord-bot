import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscordModule } from "./discord/discord.module";
import { StorageModule } from "./storage/storage.module";
import { SummarizerModule } from "./summarizer/summarizer.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DiscordModule,
    StorageModule,
    SummarizerModule,
  ],
})
export class AppModule {}
