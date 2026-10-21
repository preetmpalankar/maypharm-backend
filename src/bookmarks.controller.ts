import {
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { AuthService } from './auth/auth.service';
import { parseId } from './common/validation';
import { getMeta, getRange, paginationSchema } from './pagination';
import { SupabaseService } from './supabase.service';

const contentColumns =
  'id,title,content_type,category,product_name,brand_id,description,status,storage_bucket,storage_path,file_name,file_size,mime_type,metadata,updated_at';

/** Upper bound for the id list the app uses to mark saved items. */
const maxBookmarkIds = 2000;

type BookmarkRow = {
  created_at: string;
  content: Record<string, unknown> | null;
};

/**
 * The signed-in user's saved content. Bookmarks are personal: every query is
 * scoped to the caller, and only approved content can be saved or listed, so
 * a bookmark never outlives an item's withdrawal.
 */
@Controller('bookmarks')
export class BookmarksController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
  ) {}

  /** Saved items, newest first, with the same fields as /content. */
  @Get()
  async listBookmarks(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    const viewer = await this.auth.requireMember(authorization);
    const params = paginationSchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    const { data, error, count } = await this.supabase.admin
      .from('content_bookmarks')
      .select(`created_at,content:content_items!inner(${contentColumns})`, {
        count: 'exact',
      })
      .eq('user_id', viewer.id)
      .eq('content.status', 'approved')
      .order('created_at', { ascending: false })
      .order('content_id', { ascending: false })
      .range(from, to);

    if (error) {
      throw error;
    }

    const rows = (data ?? []) as unknown as BookmarkRow[];

    return {
      data: rows
        .filter((row) => row.content)
        .map((row) => ({ ...row.content, saved_at: row.created_at })),
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  /** Ids of every saved, still-approved item, to mark them in lists. */
  @Get('ids')
  async listBookmarkIds(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const viewer = await this.auth.requireMember(authorization);

    const { data, error } = await this.supabase.admin
      .from('content_bookmarks')
      .select('content_id,content:content_items!inner(status)')
      .eq('user_id', viewer.id)
      .eq('content.status', 'approved')
      .limit(maxBookmarkIds);

    if (error) {
      throw error;
    }

    return {
      data: ((data ?? []) as { content_id: string }[]).map(
        (row) => row.content_id,
      ),
    };
  }

  /** Saves an approved item. Saving twice is harmless. */
  @Put(':contentId')
  async addBookmark(
    @Headers('authorization') authorization: string | undefined,
    @Param('contentId') contentId: string,
  ) {
    const viewer = await this.auth.requireMember(authorization);
    const id = parseId(contentId);

    const { data: item, error: lookupError } = await this.supabase.admin
      .from('content_items')
      .select('id')
      .eq('id', id)
      .eq('status', 'approved')
      .maybeSingle();

    if (lookupError) {
      throw lookupError;
    }

    if (!item) {
      throw new NotFoundException('Content not available.');
    }

    const { error } = await this.supabase.admin
      .from('content_bookmarks')
      .upsert(
        { user_id: viewer.id, content_id: id },
        { onConflict: 'user_id,content_id', ignoreDuplicates: true },
      );

    if (error) {
      throw error;
    }

    return { data: { contentId: id, bookmarked: true } };
  }

  /** Removes a saved item. Removing one that isn't saved is harmless. */
  @Delete(':contentId')
  async removeBookmark(
    @Headers('authorization') authorization: string | undefined,
    @Param('contentId') contentId: string,
  ) {
    const viewer = await this.auth.requireMember(authorization);
    const id = parseId(contentId);

    const { error } = await this.supabase.admin
      .from('content_bookmarks')
      .delete()
      .eq('user_id', viewer.id)
      .eq('content_id', id);

    if (error) {
      throw error;
    }

    return { data: { contentId: id, bookmarked: false } };
  }
}
