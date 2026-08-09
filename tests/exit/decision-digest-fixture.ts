import type { Env } from "../../src/schema/env";
import type { StoreLayout } from "../../src/store/layout";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DriveOptions {
  actor?: string;
  env?: Env;
}

export type DriveNahel = (
  args: string[],
  options?: DriveOptions,
) => Promise<CliResult>;

export interface ChartedDecisionMaps {
  primary: { node: string; map: string; slug: "decision-digest" };
  secondary: { node: string; map: string; slug: "decision-evidence" };
}

export interface ResolvedDecisionSet {
  tickets: string[];
  distilled: string;
}

export interface ProvenanceCases {
  directHuman: string;
  delegated: string;
  ratified: string;
  agent: string;
  incomplete: string;
}

export interface ExcludedClosures {
  outOfScope: string;
  invalidated: string;
}

export interface ArchivedResolution {
  ticket: string;
  resolutionEvent: string;
}

export interface SameTimestampTie {
  timestamp: string;
  seq: number;
  ticketsInOrder: [string, string];
}

export interface IncompleteJoin {
  ticket: string;
  observation: string;
}

function red(): never {
  throw new Error("RED: Decision Digest composed exit fixture is not implemented");
}

export async function createFreshDecisionStore(
  _drive: DriveNahel,
  _root: string,
): Promise<StoreLayout> {
  return red();
}

export async function chartDecisionMaps(
  _drive: DriveNahel,
): Promise<ChartedDecisionMaps> {
  return red();
}

export async function createResolvedDecisionSet(
  _drive: DriveNahel,
  _maps: ChartedDecisionMaps,
): Promise<ResolvedDecisionSet> {
  return red();
}

export async function addProvenanceCases(
  _drive: DriveNahel,
  _maps: ChartedDecisionMaps,
): Promise<ProvenanceCases> {
  return red();
}

export async function addExcludedClosures(
  _drive: DriveNahel,
  _maps: ChartedDecisionMaps,
  _invalidatingTicket: string,
): Promise<ExcludedClosures> {
  return red();
}

export async function distillAndLocateArchivedResolution(
  _drive: DriveNahel,
  _layout: StoreLayout,
  _resolved: ResolvedDecisionSet,
): Promise<ArchivedResolution> {
  return red();
}

export async function addSameTimestampTie(
  _drive: DriveNahel,
  _layout: StoreLayout,
  _maps: ChartedDecisionMaps,
): Promise<SameTimestampTie> {
  return red();
}

export async function introduceIncompleteJoin(
  _layout: StoreLayout,
  _ticket: string,
): Promise<IncompleteJoin> {
  return red();
}

export async function installWorkflowShims(_drive: DriveNahel): Promise<void> {
  return red();
}

export async function repairIncompleteJoin(_drive: DriveNahel): Promise<CliResult> {
  return red();
}
