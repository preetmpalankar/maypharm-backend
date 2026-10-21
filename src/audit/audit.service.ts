import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase.service';

export type AuditEvent = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Records an audit event. The business action has already succeeded by the
   * time this runs, so a failed audit write is logged loudly rather than
   * turned into an error the user can do nothing about.
   */
  async record(event: AuditEvent) {
    const { error } = await this.supabase.admin.from('audit_events').insert({
      actor_id: event.actorId,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId ?? null,
      metadata: event.metadata ?? {},
    });

    if (error) {
      this.logger.error(
        `Failed to record ${event.action} for ${event.entityType}:${event.entityId ?? '-'}: ${error.message}`,
      );
    }
  }
}
