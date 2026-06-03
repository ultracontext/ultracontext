// =============================================================================
// @ultracontext/core — capability engine (HTTP/DB-agnostic)
// =============================================================================

// -- storage types ------------------------------------------------------------

export type {
    StorageAdapter,
    NodeRow,
    NodeInsertRow,
    ApiKeyRow,
    ProjectRow,
    ContextFilters,
    TransactionOptions,
} from './storage';

// -- message view -------------------------------------------------------------

export type { MessageView } from './message-view';

// -- context chain helpers ----------------------------------------------------

export {
    orderNodes,
    buildNodeInsertRecords,
    findTail,
    findHead,
    getOrderedNodes,
    getVersions,
} from './context-chain';
export type { NodeInsertInput, VersionInfo } from './context-chain';

// -- capability ops -----------------------------------------------------------

export { listContexts } from './ops/list-contexts';
export { getContextMessages } from './ops/get-context-messages';

export { createContext } from './ops/create-context';
export type { CreateContextInput } from './ops/create-context';

export { getContext } from './ops/get-context';
export type { GetContextOptions } from './ops/get-context';

export { appendMessages } from './ops/append-messages';

export { updateMessages } from './ops/update-messages';

export { deleteContextPermanent } from './ops/delete-context';
export type { DeleteContextParams } from './ops/delete-context';

export { deleteMessages } from './ops/delete-messages';
export type { DeleteMessagesParams } from './ops/delete-messages';

export { deleteManyContexts } from './ops/delete-many';
export type { DeleteResult, DeleteManyResult } from './ops/delete-many';

export { createKey } from './ops/create-key';

export { verifyKey, verifyKeyHash, hashToken } from './ops/verify-key';
export type { VerifiedKey } from './ops/verify-key';

// -- events -------------------------------------------------------------------

export { validateEnvelope, validateEmitInput, SCHEMA_VERSION, PRIVACY_LEVELS, DEFAULT_PRIVACY } from './events/envelope';
export type { EventEnvelope, EventInput, EventError, Privacy } from './events/envelope';

export type { EventStore, EventRow, DeliveryState, DeliveryCounts, EventListFilters } from './events/event-store';

export { emitEvent, commitEvent, tailEvents, eventStatus, flushPending } from './events/ops';
export type { EmitOptions, TailFilters, TailOptions, StatusContext, EventStatus, Deliver } from './events/ops';

// -- public ids ---------------------------------------------------------------

export { generatePublicId, generateEventId } from './public-ids';

// -- api keys -----------------------------------------------------------------

export { toBase62, generateKey, hashKey } from './api-keys';

// -- constants ----------------------------------------------------------------

export { KEY_PREFIX_LEN, MAX_BATCH_DELETE } from './constants';

// -- request parsing ----------------------------------------------------------

export { isPlainObject, parseUpdateRequestBody } from './request-parsing';
export type { UpdateRequestInput } from './request-parsing';

// -- first row ----------------------------------------------------------------

export { firstRow } from './first-row';

// -- result -------------------------------------------------------------------

export { ok, err, resultStatus } from './result';
export type { ErrorCode, Result } from './result';
