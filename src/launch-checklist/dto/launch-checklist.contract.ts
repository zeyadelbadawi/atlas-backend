/**
 * B3 — launch checklist response shapes. Matched by the frontend's types.
 */
import type { ChecklistSection } from './launch-checklist.dto';

export interface LaunchChecklistItemResponse {
  readonly id: string;
  readonly section: ChecklistSection;
  readonly title: string;
  readonly description: string;
  readonly linkUrl: string | null;
  readonly done: boolean;
  readonly doneAt: string | null;
  readonly doneByName: string | null;
  readonly notes: string;
  readonly position: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LaunchChecklistResponse {
  readonly items: readonly LaunchChecklistItemResponse[];
  readonly progress: { readonly done: number; readonly total: number };
}
