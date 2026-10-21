import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AssetStorageService } from './asset-storage.service';

const sweepIntervalMs = 30 * 60 * 1000;
const firstSweepDelayMs = 60 * 1000;

/**
 * Periodically deletes uploads that were sent to Storage but never attached to
 * a record (a closed tab, an abandoned form). Running it on every instance is
 * safe: deletes are idempotent.
 */
@Injectable()
export class UploadSweeperService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('UploadSweeper');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly storage: AssetStorageService) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const first = setTimeout(() => void this.sweep(), firstSweepDelayMs);
    first.unref();
    this.timer = setInterval(() => void this.sweep(), sweepIntervalMs);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async sweep() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      await this.storage.sweepAbandonedUploads();
    } catch (error) {
      this.logger.warn(`Sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
