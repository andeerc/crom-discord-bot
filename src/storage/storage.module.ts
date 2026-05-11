import { Module } from "@nestjs/common";
import { SummaryStoreService } from "./summary-store.service";

@Module({
  providers: [SummaryStoreService],
  exports: [SummaryStoreService],
})
export class StorageModule {}
