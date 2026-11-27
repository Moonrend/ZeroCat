/**
 * ActivityPub identity binding helpers.
 *
 * Inbox authorization must use one canonical actor identity across the
 * fetched document, signing key, activity, and attributed object.
 */

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function invalid(message) {
    return { valid: false, message };
}

function parseHttpIdentifier(identifier, { allowFragment }) {
    if (typeof identifier !== 'string' || !identifier) return null;

    try {
        const url = new URL(identifier);
        if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
        if (!allowFragment && url.hash) return null;
        return url;
    } catch {
        return null;
    }
}

/**
 * Canonicalize an ActivityPub actor identifier.
 */
export function canonicalActorId(identifier) {
    return parseHttpIdentifier(identifier, { allowFragment: false })?.href || null;
}

/**
 * Canonicalize an ActivityPub signing-key identifier.
 */
export function canonicalKeyId(identifier) {
    return parseHttpIdentifier(identifier, { allowFragment: true })?.href || null;
}

/**
 * Return the canonical actor-document URL selected by a key ID.
 */
export function getKeyDocumentUrl(keyId) {
    const url = parseHttpIdentifier(keyId, { allowFragment: true });
    if (!url) return null;
    url.hash = '';
    return url.href;
}

/**
 * Require a fetched actor document to identify itself as the requested URL.
 */
export function validateFetchedActorIdentity(actor, requestedActorUrl) {
    const requestedId = canonicalActorId(requestedActorUrl);
    if (!requestedId) return invalid('Invalid actor document URL');

    const actorId = canonicalActorId(actor?.id);
    if (!actorId) return invalid('Actor document has an invalid id');
    if (actorId !== requestedId) return invalid('Actor id does not match the fetched document URL');

    return { valid: true, actorId };
}

/**
 * Bind a fetched actor and its public key to the key ID from the signature.
 */
export function validateActorKeyBinding({ actor, keyId, localBaseUrl = null }) {
    const canonicalKey = canonicalKeyId(keyId);
    const actorDocumentUrl = getKeyDocumentUrl(keyId);
    if (!canonicalKey || !actorDocumentUrl) return invalid('Signature keyId is not a valid HTTP URL');

    const actorIdentity = validateFetchedActorIdentity(actor, actorDocumentUrl);
    if (!actorIdentity.valid) return actorIdentity;

    if (localBaseUrl) {
        const localUrl = parseHttpIdentifier(localBaseUrl, { allowFragment: false });
        if (!localUrl) return invalid('Local ActivityPub base URL is invalid');
        if (new URL(actorIdentity.actorId).host === localUrl.host) {
            return invalid('Remote signature cannot claim a local actor');
        }
    }

    const publicKey = actor?.publicKey;
    if (!publicKey || Array.isArray(publicKey) || typeof publicKey !== 'object') {
        return invalid('Actor document has no public key');
    }

    const publicKeyId = canonicalKeyId(publicKey.id);
    if (!publicKeyId || publicKeyId !== canonicalKey) {
        return invalid('Public key id does not match Signature keyId');
    }

    const ownerId = canonicalActorId(publicKey.owner);
    if (!ownerId || ownerId !== actorIdentity.actorId) {
        return invalid('Public key owner does not match actor id');
    }

    if (typeof publicKey.publicKeyPem !== 'string' || !publicKey.publicKeyPem.trim()) {
        return invalid('Actor public key has no PEM value');
    }

    return {
        valid: true,
        actorId: actorIdentity.actorId,
        keyId: canonicalKey,
        publicKeyPem: publicKey.publicKeyPem,
    };
}

function extractSingleIdentifier(value) {
    if (Array.isArray(value)) {
        return value.length === 1 ? extractSingleIdentifier(value[0]) : null;
    }
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
    return null;
}

function extractAttributedIdentifiers(value) {
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) return null;

    const identifiers = values.map(extractSingleIdentifier);
    return identifiers.every(Boolean) ? identifiers : null;
}

/**
 * Bind activity-level identity claims to the actor authenticated by the key.
 */
export function validateActivityActorBinding(activity, authenticatedActorId) {
    const actorId = canonicalActorId(authenticatedActorId);
    if (!actorId) return invalid('Authenticated actor has an invalid id');

    const activityActorId = canonicalActorId(extractSingleIdentifier(activity?.actor));
    if (!activityActorId) return invalid('Activity has no valid actor');
    if (activityActorId !== actorId) return invalid('Activity actor does not match the authenticated actor');

    const object = activity?.object;
    if (activity?.type === 'Create' && object && typeof object === 'object' &&
        (object.type === 'Note' || object.type === 'Article')) {
        const attributedIdentifiers = extractAttributedIdentifiers(object.attributedTo);
        if (!attributedIdentifiers) return invalid('Created object has no valid attributedTo');

        const attributionMatches = attributedIdentifiers.every(identifier =>
            canonicalActorId(identifier) === actorId
        );
        if (!attributionMatches) {
            return invalid('Created object attribution does not match the authenticated actor');
        }
    }

    if (activity?.type === 'Update' && object && typeof object === 'object' &&
        (object.type === 'Person' || object.type === 'Service' || object.type === 'Application')) {
        const updatedActorId = canonicalActorId(object.id);
        if (!updatedActorId || updatedActorId !== actorId) {
            return invalid('Updated actor does not match the authenticated actor');
        }
    }

    return { valid: true, actorId };
}
