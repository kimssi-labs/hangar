/** The account's Artifacts on claude.ai: the list as last fetched, fetching it again, opening one. */
import { invoke } from "../../bridge/contract.js";
import type { ArtifactOrigins } from "../../core/artifactOrigins.js";
import type { ArtifactsState } from "../../core/artifacts.js";
import type { ActionResult } from "../../main/ipc.js";

export const artifactsContract = {
  /** The list as last fetched — from the cache file, so it is there before any network call. */
  artifactsState: invoke<void, ArtifactsState>("artifacts:state"),
  /** Ask claude.ai again. A failure keeps the previous list and says why. */
  refreshArtifacts: invoke<void, ArtifactsState>("artifacts:refresh"),
  /** Which project and session published each Artifact, read from the transcripts. */
  artifactOrigins: invoke<void, ArtifactOrigins>("artifacts:origins"),
  /** Open one in the browser — only an Artifact page on claude.ai. */
  openArtifact: invoke<string, ActionResult>("artifacts:open"),
  /** Give one of this account's Artifacts a new title on claude.ai; the cached list follows. */
  renameArtifact: invoke<{ slug: string; title: string }, ActionResult>("artifacts:rename"),
  /** Delete one of this account's Artifacts on claude.ai, for good; the cached list follows. */
  deleteArtifact: invoke<string, ActionResult>("artifacts:delete"),
} as const;
