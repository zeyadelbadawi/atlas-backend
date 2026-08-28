/**
 * SearchController — `search` (master plan §21 Phase P17), matching
 * `SearchService` (atlas frontend)'s single flat resource exactly
 * (`GET /search?q=`). Every authenticated user may call this — the
 * category-level Platform Owner restriction is enforced inside
 * `SearchService`, never at this route-guard layer (there is no single
 * role gate that would be correct here, since the SAME endpoint returns
 * different category sets for different callers).
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { SearchService } from '../services/search.service';
import { SearchQueryDto } from '../dto/search-query.dto';
import type { SearchResultsResponse } from '../dto/search.contract';

@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  async search(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: SearchQueryDto,
  ): Promise<SearchResultsResponse> {
    return this.searchService.search(auth.userId, query.q);
  }
}
