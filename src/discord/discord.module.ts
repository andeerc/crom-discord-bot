import { Module } from "@nestjs/common";
import { DiscordService } from "./discord.service";
import { StorageModule } from "src/storage/storage.module";
import { SummarizerModule } from "src/summarizer/summarizer.module";

@Module({
  imports: [StorageModule, SummarizerModule],
  providers: [DiscordService],
  exports: [DiscordService],
})
export class DiscordModule {}
