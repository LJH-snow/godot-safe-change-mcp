import {
  findReferencesInputSchema,
  type FindReferencesInput,
  type FindReferencesReport,
} from "../domain/reference-contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import { findProjectReferences, sharedProjectIndexCache } from "../infrastructure/project-index.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

export interface ReferenceService {
  findReferences(input: FindReferencesInput): Promise<FindReferencesReport>;
}

export class LocalReferenceService implements ReferenceService {
  async findReferences(input: FindReferencesInput): Promise<FindReferencesReport> {
    const parsedInput = findReferencesInputSchema.parse(input);
    const target = parsedInput.target.trim();
    if (target.length === 0) {
      throw new DomainError(ERROR_CODES.VALIDATION_FAILED, "The reference target must not be empty.");
    }
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const { references, truncated } = await findProjectReferences(projectRoot, target, {
      limit: parsedInput.limit,
      cache: sharedProjectIndexCache,
    });
    return {
      schemaVersion: "0.1",
      projectRoot,
      target,
      references,
      truncated,
    };
  }
}
