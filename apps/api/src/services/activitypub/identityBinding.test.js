import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getKeyDocumentUrl,
    validateActorKeyBinding,
    validateActivityActorBinding,
    validateFetchedActorIdentity,
} from './identityBinding.js';

const ACTOR_ID = 'https://remote.example/users/alice';
const KEY_ID = `${ACTOR_ID}#main-key`;

function remoteActor(overrides = {}) {
    return {
        id: ACTOR_ID,
        type: 'Person',
        publicKey: {
            id: KEY_ID,
            owner: ACTOR_ID,
            publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
        },
        ...overrides,
    };
}

test('canonical remote actor and owned key are accepted', () => {
    const actor = remoteActor({
        id: 'HTTPS://REMOTE.EXAMPLE:443/users/alice',
        publicKey: {
            id: 'HTTPS://REMOTE.EXAMPLE:443/users/alice#main-key',
            owner: 'HTTPS://REMOTE.EXAMPLE:443/users/alice',
            publicKeyPem: 'public-key',
        },
    });

    assert.equal(getKeyDocumentUrl(actor.publicKey.id), ACTOR_ID);
    assert.deepEqual(validateFetchedActorIdentity(actor, ACTOR_ID), { valid: true, actorId: ACTOR_ID });
    assert.deepEqual(
        validateActorKeyBinding({ actor, keyId: KEY_ID, localBaseUrl: 'https://local.example' }),
        { valid: true, actorId: ACTOR_ID, keyId: KEY_ID, publicKeyPem: 'public-key' }
    );
});

test('actor document, key id, and key owner must identify the same actor', () => {
    assert.equal(
        validateFetchedActorIdentity(remoteActor({ id: 'https://victim.example/users/bob' }), ACTOR_ID).valid,
        false
    );
    assert.equal(
        validateActorKeyBinding({
            actor: remoteActor({ publicKey: { ...remoteActor().publicKey, id: `${ACTOR_ID}#other-key` } }),
            keyId: KEY_ID,
        }).valid,
        false
    );
    assert.equal(
        validateActorKeyBinding({
            actor: remoteActor({ publicKey: { ...remoteActor().publicKey, owner: 'https://victim.example/users/bob' } }),
            keyId: KEY_ID,
        }).valid,
        false
    );
});

test('remote key documents cannot claim the local host', () => {
    const localActorId = 'http://local.example/ap/users/admin';
    const actor = remoteActor({
        id: localActorId,
        publicKey: {
            id: `${localActorId}#main-key`,
            owner: localActorId,
            publicKeyPem: 'public-key',
        },
    });

    const result = validateActorKeyBinding({
        actor,
        keyId: `${localActorId}#main-key`,
        localBaseUrl: 'https://local.example',
    });
    assert.equal(result.valid, false);
    assert.equal(result.message, 'Remote signature cannot claim a local actor');
});

test('activity actor and created-object attribution remain bound to the signer', () => {
    const legitimate = {
        type: 'Create',
        actor: { id: ACTOR_ID },
        object: { type: 'Note', attributedTo: [ACTOR_ID], content: 'hello' },
    };
    assert.deepEqual(validateActivityActorBinding(legitimate, ACTOR_ID), { valid: true, actorId: ACTOR_ID });

    assert.equal(
        validateActivityActorBinding({ ...legitimate, actor: 'https://victim.example/users/bob' }, ACTOR_ID).valid,
        false
    );
    assert.equal(
        validateActivityActorBinding({
            ...legitimate,
            object: { ...legitimate.object, attributedTo: 'https://victim.example/users/bob' },
        }, ACTOR_ID).valid,
        false
    );
    assert.equal(
        validateActivityActorBinding({
            ...legitimate,
            object: { ...legitimate.object, attributedTo: undefined },
        }, ACTOR_ID).valid,
        false
    );
});

test('actor updates can only update the authenticated actor', () => {
    const legitimate = {
        type: 'Update',
        actor: ACTOR_ID,
        object: { type: 'Person', id: ACTOR_ID, name: 'Alice' },
    };
    assert.deepEqual(validateActivityActorBinding(legitimate, ACTOR_ID), { valid: true, actorId: ACTOR_ID });
    assert.equal(
        validateActivityActorBinding({
            ...legitimate,
            object: { ...legitimate.object, id: 'https://victim.example/users/bob' },
        }, ACTOR_ID).valid,
        false
    );
});
