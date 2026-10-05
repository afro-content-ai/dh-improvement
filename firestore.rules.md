rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ═══════════════════════════════════════════════════════════════════════
    // DH BINGO — CARD INVENTORY + PRE-SESSION MARKETPLACE  (Firebase SPARK safe)
    //
    // Data model (all authoritative in Firestore; nothing here needs Cloud Functions)
    //
    //   cardCatalog/{cardId}            10,000 permanent cards "10000".."19999".
    //                                   Read-only for every client. Seeded once with the Admin SDK.
    //   settings/cardMarket             The "round ledger" for the session that is FORMING:
    //                                   { roundId, sessionId|null, totalCardCount, playerCount, totalPot, jackpot }
    //                                   sessionId == null  -> NO session exists yet -> pre-session
    //                                   marketplace is open ("next session"). Holds the counters
    //                                   while no session doc exists; the session doc holds them after.
    //   cardReservations/{roundId}      ONE doc per round: { roundId, reserved: { "<cardId>": true } }.
    //                                   Rules only ever let keys be ADDED (never changed/overwritten),
    //                                   or removed together with the owner's order. Adding an existing
    //                                   key is therefore impossible => atomic "reserve or fail".
    //                                   A new round = a new doc, so nothing has to be deleted/released
    //                                   between sessions (Spark delete quota untouched).
    //   cardOrders/{roundId}_{uid}      One order per user per round (max 20 cards):
    //                                   status 'pending_next_session' (sessionId null) -> 'assigned'
    //                                   (sessionId set once attached) -> 'refunded' (admin sweep).
    //   sessions/{id}                   Existing session doc + { roundId, totalCardCount, winnerCardId }.
    //   sessions/{id}/players/{uid}     Existing player doc + { roundId, cardIds, cardNumbers:[{cardId,numbers}] }
    //                                   cardNumbers is a SNAPSHOT; cardCatalog is the source of truth.
    //
    // LIMITS enforced HERE (not in the UI): 20 cards/user/round, 10,000 cards/session, 60 s lock,
    // no purchases unless the session is 'waiting' with more than LOCK_SECONDS remaining (or no
    // session exists yet). Per-purchase pricing: gross = cardCount * price, where price is 10 ETB before a
    // session exists and the SESSION's own `cardValue` (5 | 10 | 30, validated at session create and
    // immutable for non-admins) afterwards. Only at 10 ETB is a bulk discount applied (see discountFor()),
    // based ONLY on that purchase's card count. The resulting stake is split 80% jackpot / 20% house —
    // never the flat "8 ETB/card" split of the old model.
    //
    // REPRICED SESSIONS (cardValue 5 or 30): anything bought before the session existed was bought at the
    // 10-ETB pre-session price and is NEVER repriced or attached. Such a session is created on a BRAND-NEW
    // round (new reservation doc, all counters 0, `repricedFromRoundId` = the old round) in one request, so old
    // pending orders can never attach (orderAttachOk also pins the round and cardValue 10). The admin client
    // then refunds each old pending order at its own recorded `stake` (admin writes; one order per
    // transaction, status flips to 'refunded' atomically with the wallet credit => never refunded twice).
    //
    // ─────────────────────────────────────────────────────────────────────────
    // SECURITY-RULES DOCUMENT-ACCESS BUDGET   (limits: 20 per request, 10 per operation)
    //
    // MEASURED by executing this file in tests/sim/ (a purpose-built interpreter — NOT Google's emulator;
    // see tests/emulator/ for the real-emulator suite). Counts assume NO caching (get()+exists() on one
    // doc are counted separately) and that && / || short-circuit. Call sites test cheap request/resource
    // discriminators BEFORE any function that performs get()/getAfter()/exists(), so a branch that does
    // not apply costs 0 accesses. Purchase cost does NOT depend on how many cards are bought (1 or 20):
    // reservations are ONE map document, not one document per card.
    //
    //   PURCHASE, any 1..20 cards          pre-session (settings/cardMarket)   in-session (sessions/{id})
    //     cardReservations  add keys          1                                   1
    //     cardOrders        create/append     4                                   5
    //     counters doc      (market|session)  2                                   2
    //     users/{me}        debit             0                                   0
    //     settings/house    credit            2                                   2
    //     players/{me}      create/append     -                                   1
    //     TOTAL                               9  (max op 4)                       11 (max op 5)
    //
    //   ATTACH one pending order:  owner (self-heal) 2 (max op 1)   admin 4 (max op 2)
    //   RELEASE / LEAVE (cancel):  pre-session 13 (max op 4)        in-session 15 (max op 4)   [12/14 measured; +1 for the exists() guard added afterwards]
    //   SESSION CREATE (admin, 3 docs) 8 (max op 4)       ROUND ADVANCE (any player, 2 docs) 7 (max op 4)
    //   SESSION ACTIVATE, on time (admin) 0               SESSION ACTIVATE, late fallback (any player) 0
    //   ADMIN BOOTSTRAP (market + reservations) 4        ADMIN REFUND of ONE player (5 docs) 12
    //   -> refunds MUST stay one player per transaction (a batch of two players would exceed 20).
    //   Purchase attempts against a locked / active / full session are rejected by the counters doc's own
    //   state check (no access budget needed to reach the verdict).
    // ═══════════════════════════════════════════════════════════════════════

    // ── constants ─────────────────────────────────────────────────────────
    function CARD_PRICE()        { return 10; }
    // Session card values an admin may choose. CARD_PRICE() (10) is the default and the pre-session price.
    function MAX_CARD_VALUE()    { return 30; }
    function isCardValue(v)      { return v is int && (v == 5 || v == 10 || v == 30); }
    // A session doc's card value. Sessions created before the field existed are standard 10-ETB sessions.
    function cardValueOf(c)      { return c.get('cardValue', CARD_PRICE()); }
    function MAX_USER_CARDS()    { return 20; }
    function MAX_SESSION_CARDS() { return 10000; }
    function LOCK_SECONDS()      { return 60; }
    // How long the admin browser gets first right of way to activate a session on its own (attach any
    // still-pending card orders, then flip status) before any other online player's client is allowed to
    // nudge it forward instead. See sessionActivateOk() below.
    function ACTIVATE_GRACE_SECONDS() { return 20; }

    // ── identity ──────────────────────────────────────────────────────────
    function isAdmin() {
      return request.auth != null
        && exists(/databases/$(database)/documents/users/$(request.auth.uid))
        && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
    function isOwner(uid) {
      return request.auth != null && request.auth.uid == uid;
    }
    function isLoggedIn() {
      return request.auth != null;
    }

    // ── paths ─────────────────────────────────────────────────────────────
    function pUser(uid)        { return /databases/$(database)/documents/users/$(uid); }
    function pMarket()         { return /databases/$(database)/documents/settings/cardMarket; }
    function pSession(sid)     { return /databases/$(database)/documents/sessions/$(sid); }
    function pPlayer(sid, uid) { return /databases/$(database)/documents/sessions/$(sid)/players/$(uid); }
    function pOrder(rid, uid)  { return /databases/$(database)/documents/cardOrders/$(rid + '_' + uid); }
    function pResv(rid)        { return /databases/$(database)/documents/cardReservations/$(rid); }
    function pCounters(sid)    { return sid == null ? pMarket() : pSession(sid); }

    // ── value validators (0 document accesses) ────────────────────────────
    function isRoundId(x) { return x is string && x.matches('^[A-Za-z0-9]{20}$'); }
    // Card IDs are exactly "10000".."19999" and the catalog is contiguous, so a well-formed
    // id IS an existing catalog card — no per-card lookup needed.
    function isCardId(x)  { return x is string && x.matches('^1[0-9]{4}$'); }
    function idAt(l, i)   { return l.size() <= i || isCardId(l[i]); }
    function isCardIdList(l) {
      return l is list && l.size() >= 1 && l.size() <= 20
        && idAt(l, 0) && idAt(l, 1) && idAt(l, 2) && idAt(l, 3) && idAt(l, 4)
        && idAt(l, 5) && idAt(l, 6) && idAt(l, 7) && idAt(l, 8) && idAt(l, 9)
        && idAt(l, 10) && idAt(l, 11) && idAt(l, 12) && idAt(l, 13) && idAt(l, 14)
        && idAt(l, 15) && idAt(l, 16) && idAt(l, 17) && idAt(l, 18) && idAt(l, 19)
        && l.toSet().size() == l.size();
    }
    // reserved[cardId] must be literally `true` for each card in this batch, so nobody can
    // stuff a huge value into the shared reservation doc.
    function valAt(m, l, i) { return l.size() <= i || m[l[i]] == true; }

    // ── pricing (0 document accesses) — derived from card count ONLY, never trusted from the client ──
    // Bulk discount for a single purchase, keyed only on how many cards are in THAT purchase.
    // isCardIdList() already bounds n to 1..MAX_USER_CARDS()(20), so every branch here is reachable.
    // `v` is the card value in force (5 | 10 | 30). Quantity discounts exist ONLY at the standard 10 ETB.
    function discountFor(n, v) {
      return v != CARD_PRICE() ? 0
           : n <= 3  ? 0
           : n <= 7  ? 10
           : n <= 11 ? 20
           : n <= 15 ? 30
           : 40;
    }
    // The actual, authoritative stake for a purchase of n cards at card value v: gross (n * v) minus the
    // discount. This — not n * v — is what must be debited, and what `stake` must equal.
    function stakeFor(n, v) { return n * v - discountFor(n, v); }
    // Pre-session marketplace price (no session exists yet => always the standard 10 ETB).
    function batchStake(n)  { return stakeFor(n, CARD_PRICE()); }
    // 20% / 80% split of any ETB amount that is itself a sum of stakeFor() values. Every possible stake
    // (n*5, n*10 minus a multiple of 10, n*30) is an exact multiple of 5 ETB, so houseShare()'s integer
    // division never truncates, and jackpotShare() is computed as the remainder so
    // totalPot == jackpot + houseShare ALWAYS holds exactly, with no floating-point rounding drift from
    // multiplying by 0.8 / 0.2 directly.
    function houseShare(amt)   { return amt / 5; }
    function jackpotShare(amt) { return amt - houseShare(amt); }

    // ═════════════════════════════════════════════════════════════════════
    // users/{uid}
    // ═════════════════════════════════════════════════════════════════════
    // A user may only LOWER their own balance (a purchase) by 1..(MAX_USER_CARDS()*MAX_CARD_VALUE()) ETB —
    // a loose sanity ceiling only. This is deliberately self-harm-only: the doc that actually enforces
    // "paid exactly batchStake(n) for n cards" is the counters doc (marketPurchaseOk / sessionPurchaseOk),
    // which compares this doc before/after. 0 accesses.
    function userDebitOk() {
      let d = resource.data.balance - request.resource.data.balance;
      return d > 0 && d <= MAX_USER_CARDS() * MAX_CARD_VALUE() && request.resource.data.balance >= 0;
    }
    // A user may only RAISE their own balance by exactly the stake of THEIR order, and only in
    // the same request that DELETES that order (existsAfter). This closes the replay hole where a
    // credit could be written repeatedly while the registration still existed.
    // Accesses: get(market) 1 + exists(order) 1 + get(order) 1 + existsAfter(order) 1 = 4.
    function userReleaseCreditOk(uid) {
      let rid = get(pMarket()).data.roundId;
      return exists(pOrder(rid, uid))
        && (request.resource.data.balance - resource.data.balance) == get(pOrder(rid, uid)).data.stake
        && !existsAfter(pOrder(rid, uid));
    }

    match /users/{uid} {
      allow read: if isOwner(uid) || isAdmin();
      allow create: if isOwner(uid)
        && request.resource.data.keys().hasAll(['phone','balance','role','createdAt'])
        && request.resource.data.balance == 0
        && request.resource.data.role == 'player';
      allow update: if
        // self-service presence/profile fields — never touches balance or role
        (isOwner(uid)
          && request.resource.data.diff(resource.data).affectedKeys()
              .hasOnly(['isOnline','lastSeen','theme','sound','autoMark']))
        // balance: only a purchase debit, or the credit of an order deleted in this same request
        || (isOwner(uid)
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['balance'])
          && ((request.resource.data.balance < resource.data.balance && userDebitOk())
              || (request.resource.data.balance > resource.data.balance && userReleaseCreditOk(uid))))
        || isAdmin();
      allow delete: if isAdmin();
    }

    // ═════════════════════════════════════════════════════════════════════
    // cardCatalog/{cardId}  — immutable for every client (Admin SDK seeds it)
    // ═════════════════════════════════════════════════════════════════════
    match /cardCatalog/{cardId} {
      allow read: if isLoggedIn();
      allow create, update, delete: if false;
    }

    // ═════════════════════════════════════════════════════════════════════
    // cardReservations/{roundId}
    // ═════════════════════════════════════════════════════════════════════
    // ADD: only new keys, each `true`, and the added set must equal the order's lastBatch exactly.
    // Access: getAfter(order) = 1.
    function reservationAddOk(roundId) {
      let b = resource.data;
      let a = request.resource.data;
      let d = a.reserved.diff(b.reserved);
      let o = getAfter(pOrder(roundId, request.auth.uid)).data;
      return d.changedKeys().size() == 0 && d.removedKeys().size() == 0
        && d.addedKeys() == o.lastBatch.toSet()
        && o.roundId == roundId && o.uid == request.auth.uid
        && valAt(a.reserved, o.lastBatch, 0) && valAt(a.reserved, o.lastBatch, 1)
        && valAt(a.reserved, o.lastBatch, 2) && valAt(a.reserved, o.lastBatch, 3)
        && valAt(a.reserved, o.lastBatch, 4) && valAt(a.reserved, o.lastBatch, 5)
        && valAt(a.reserved, o.lastBatch, 6) && valAt(a.reserved, o.lastBatch, 7)
        && valAt(a.reserved, o.lastBatch, 8) && valAt(a.reserved, o.lastBatch, 9)
        && valAt(a.reserved, o.lastBatch, 10) && valAt(a.reserved, o.lastBatch, 11)
        && valAt(a.reserved, o.lastBatch, 12) && valAt(a.reserved, o.lastBatch, 13)
        && valAt(a.reserved, o.lastBatch, 14) && valAt(a.reserved, o.lastBatch, 15)
        && valAt(a.reserved, o.lastBatch, 16) && valAt(a.reserved, o.lastBatch, 17)
        && valAt(a.reserved, o.lastBatch, 18) && valAt(a.reserved, o.lastBatch, 19)
        && a.reserved.size() <= MAX_SESSION_CARDS();
    }
    // RELEASE: removes exactly the cards of the caller's order, and only while that order is being
    // deleted in the same request. Accesses: get(order) + existsAfter(order) = 2.
    function reservationReleaseOk(roundId) {
      let b = resource.data;
      let a = request.resource.data;
      let d = a.reserved.diff(b.reserved);
      let o = get(pOrder(roundId, request.auth.uid)).data;
      return d.addedKeys().size() == 0 && d.changedKeys().size() == 0
        && d.removedKeys() == o.cardIds.toSet()
        && !existsAfter(pOrder(roundId, request.auth.uid));
    }
    // CREATE for a new round: only together with the market doc moving to exactly this roundId.
    // Accesses: get(market) + getAfter(market) = 2.
    function reservationCreateOnAdvanceOk(roundId) {
      return getAfter(pMarket()).data.roundId == roundId
        && get(pMarket()).data.roundId != roundId;
    }

    match /cardReservations/{roundId} {
      allow read: if isLoggedIn();
      // isAdmin() FIRST: on the very first bootstrap the market doc does not exist yet, so the advance
      // branch below would error; the rule must not depend on how an error inside `||` is treated.
      allow create: if isAdmin()
        || (isLoggedIn() && isRoundId(roundId)
          && request.resource.data.keys().hasOnly(['roundId','reserved'])
          && request.resource.data.roundId == roundId
          && request.resource.data.reserved == {}
          && reservationCreateOnAdvanceOk(roundId));
      allow update: if
        (isLoggedIn()
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['reserved'])
          && request.resource.data.reserved.size() > resource.data.reserved.size()
          && reservationAddOk(roundId))
        || (isLoggedIn()
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['reserved'])
          && request.resource.data.reserved.size() < resource.data.reserved.size()
          && reservationReleaseOk(roundId))
        || isAdmin();   // admin can repair a round; users never can
      allow delete: if isAdmin();
    }

    // ═════════════════════════════════════════════════════════════════════
    // cardOrders/{roundId}_{uid}
    // ═════════════════════════════════════════════════════════════════════
    // Shape/limits of the order AFTER a create/append. 0 accesses.
    function orderShapeOk(orderId) {
      let a = request.resource.data;
      return a.keys().hasOnly(['uid','phone','roundId','sessionId','status','cardIds','ticketCount',
                               'stake','lastBatch','purchaseSeq','createdAt','updatedAt','attachedAt'])
        && a.uid == request.auth.uid
        && isRoundId(a.roundId)
        && orderId == a.roundId + '_' + request.auth.uid
        && a.phone is string && a.phone.size() <= 20
        && a.purchaseSeq is int && a.purchaseSeq >= 1
        && isCardIdList(a.lastBatch)
        && a.cardIds is list
        && a.ticketCount is int && a.ticketCount >= 1 && a.ticketCount <= MAX_USER_CARDS()
        && a.cardIds.size() == a.ticketCount
        && a.cardIds.toSet().size() == a.ticketCount
        && a.stake is int && a.stake > 0
        && a.createdAt is timestamp && a.updatedAt is timestamp;
    }
    // Forces the OTHER documents of a purchase to move by exactly this batch (get = state BEFORE the
    // request, getAfter = state AFTER it), so an order can never be written without the counters,
    // the reservations and (in-session) the player doc moving with it.
    // Accesses: get+getAfter(counters) 2 + get+getAfter(reservations) 2 [+ getAfter(player) 1 in-session].
    // `prevStake` = the order's stake BEFORE this request (0 for a create). The price is read from the counters
    // doc already fetched here (no extra access): pre-session = 10 ETB, in-session = the session's cardValue.
    function orderPurchaseLinks(a, prevStake) {
      let n  = a.lastBatch.size();
      let c0 = get(pCounters(a.sessionId)).data;
      let c1 = getAfter(pCounters(a.sessionId)).data;
      let r0 = get(pResv(a.roundId)).data;
      let r1 = getAfter(pResv(a.roundId)).data;
      let v  = a.sessionId == null ? CARD_PRICE() : cardValueOf(c0);
      let cost = stakeFor(n, v);
      return isCardValue(v)
        && a.stake == prevStake + cost
        && c0.roundId == a.roundId
        // state gate (defence in depth: the counters doc's own rule also enforces it)
        && (a.sessionId == null
              ? c0.sessionId == null
              : (c0.status == 'waiting'
                  && request.time < c0.countdownEnd - duration.value(LOCK_SECONDS(), 's')))
        && c1.totalCardCount - c0.totalCardCount == n
        && c1.playerCount - c0.playerCount == (a.purchaseSeq == 1 ? 1 : 0)
        && c1.totalPot - c0.totalPot == cost
        && c1.jackpot - c0.jackpot == jackpotShare(cost)
        && !r0.reserved.keys().hasAny(a.lastBatch)
        && r1.reserved.keys().hasAll(a.lastBatch)
        && (a.sessionId == null
              || getAfter(pPlayer(a.sessionId, request.auth.uid)).data.ticketCount == a.ticketCount);
    }
    function orderCreateOk(orderId) {
      let a = request.resource.data;
      return orderShapeOk(orderId)
        && a.purchaseSeq == 1
        && a.cardIds == a.lastBatch
        && (a.sessionId == null ? a.status == 'pending_next_session' : a.status == 'assigned')
        && orderPurchaseLinks(a, 0);   // also enforces stake == this batch's stakeFor()
    }
    function orderAppendOk(orderId) {
      let b = resource.data;
      let a = request.resource.data;
      return (b.status == 'pending_next_session' || b.status == 'assigned')
        && a.status == b.status && a.sessionId == b.sessionId && a.roundId == b.roundId
        && a.createdAt == b.createdAt
        && a.cardIds == b.cardIds.concat(a.lastBatch)
        && !b.cardIds.hasAny(a.lastBatch)
        && orderShapeOk(orderId)
        && orderPurchaseLinks(a, b.stake);   // also enforces stake == b.stake + this batch's stakeFor()
    }
    // pending_next_session -> assigned, done by the owner (self-heal) — admin uses isAdmin().
    // Access: get(session) = 1.
    function orderAttachOk() {
      let b = resource.data;
      let a = request.resource.data;
      let s = get(pSession(a.sessionId)).data;
      return b.status == 'pending_next_session' && b.sessionId == null
        && a.status == 'assigned' && a.sessionId is string
        // pre-session orders were bought at 10 ETB: they may only join a standard 10-ETB session of the SAME round
        // (5 / 30 ETB sessions live on a new round and refund the old orders instead — they are never repriced)
        && s.roundId == b.roundId && s.status == 'waiting' && cardValueOf(s) == CARD_PRICE();
    }
    // Deleting an order = cancel & refund. Forces the counters back down by exactly this order,
    // the reserved keys released, and (in-session) the player doc deleted.
    // Accesses: get+getAfter(counters) 2 + getAfter(reservations) 1 [+ existsAfter(player) 1].
    function orderReleaseOk(o) {
      let c0 = get(pCounters(o.sessionId)).data;
      let c1 = getAfter(pCounters(o.sessionId)).data;
      let r1 = getAfter(pResv(o.roundId)).data;
      return c0.roundId == o.roundId
        && (o.sessionId == null ? c0.sessionId == null : c0.status == 'waiting')
        && c0.totalCardCount - c1.totalCardCount == o.ticketCount
        && c0.playerCount - c1.playerCount == 1
        && c0.totalPot - c1.totalPot == o.stake
        && c0.jackpot - c1.jackpot == jackpotShare(o.stake)
        && !r1.reserved.keys().hasAny(o.cardIds)
        && (o.sessionId == null || !existsAfter(pPlayer(o.sessionId, request.auth.uid)));
    }

    match /cardOrders/{orderId} {
      allow read: if (isLoggedIn() && orderId.split('_')[1] == request.auth.uid) || isAdmin();
      allow create: if isLoggedIn() && orderCreateOk(orderId);
      allow update: if
        (isLoggedIn() && resource.data.uid == request.auth.uid
          && request.resource.data.purchaseSeq == resource.data.purchaseSeq + 1
          && orderAppendOk(orderId))
        || (isLoggedIn() && resource.data.uid == request.auth.uid
          && request.resource.data.purchaseSeq == resource.data.purchaseSeq
          && request.resource.data.diff(resource.data).affectedKeys()
              .hasOnly(['status','sessionId','attachedAt','updatedAt'])
          // only evaluate the attach check for a genuine attach (not e.g. an admin marking the order 'refunded'),
          // so this branch can never error before the `|| isAdmin()` fallback is reached
          && request.resource.data.status == 'assigned'
          && request.resource.data.sessionId is string
          && orderAttachOk())
        || isAdmin();
      allow delete: if
        (isLoggedIn() && resource.data.uid == request.auth.uid
          && (resource.data.status == 'pending_next_session' || resource.data.status == 'assigned')
          && orderReleaseOk(resource.data))
        || isAdmin();
    }

    // ═════════════════════════════════════════════════════════════════════
    // settings/{docId}  (house, sessionControl, paymentAccounts, cardMarket)
    // ═════════════════════════════════════════════════════════════════════
    // house: may only move opposite to the caller's own balance change in the SAME request
    // (credit on purchase, debit on release). Accesses: get+getAfter(users/{me}) = 2.
    function houseMirrorsUserOk() {
      let u0 = get(pUser(request.auth.uid)).data;
      let u1 = getAfter(pUser(request.auth.uid)).data;
      return (request.resource.data.balance - resource.data.balance) == (u0.balance - u1.balance);
    }

    // cardMarket PURCHASE (no session exists yet). Accesses: get+getAfter(users/{me}) = 2.
    function marketPurchaseOk() {
      let b = resource.data;
      let a = request.resource.data;
      let n = a.totalCardCount - b.totalCardCount;
      let paid = get(pUser(request.auth.uid)).data.balance - getAfter(pUser(request.auth.uid)).data.balance;
      return a.diff(b).affectedKeys().hasOnly(['totalCardCount','playerCount','totalPot','jackpot'])
        && n >= 1 && n <= MAX_USER_CARDS()
        && a.totalCardCount <= MAX_SESSION_CARDS()
        && (a.playerCount - b.playerCount == 0 || a.playerCount - b.playerCount == 1)
        && a.totalPot - b.totalPot == batchStake(n)
        && a.jackpot - b.jackpot == jackpotShare(batchStake(n))
        && paid == batchStake(n);
    }
    // cardMarket RELEASE (cancel a pending order). Accesses: get(order) + existsAfter(order) = 2.
    function marketReleaseOk() {
      let b = resource.data;
      let a = request.resource.data;
      let o = get(pOrder(b.roundId, request.auth.uid)).data;
      return a.diff(b).affectedKeys().hasOnly(['totalCardCount','playerCount','totalPot','jackpot'])
        && o.sessionId == null
        && !existsAfter(pOrder(b.roundId, request.auth.uid))
        && b.totalCardCount - a.totalCardCount == o.ticketCount
        && b.playerCount - a.playerCount == 1
        && b.totalPot - a.totalPot == o.stake
        && b.jackpot - a.jackpot == jackpotShare(o.stake);
    }
    // cardMarket ADVANCE: opens the NEXT round. Anyone may trigger it, but only once the previous
    // session is provably finished: ended/force_ended, settlement complete, result window elapsed.
    // The new round's reservation doc must be CREATED by this same request (absent before, present after):
    // otherwise a user could strand the marketplace (no reservation doc) or roll it back onto an OLD round
    // whose cards are still reserved.
    // Accesses: get(session) 1 + exists(reservations) 1 + existsAfter(reservations) 1 = 3.
    function marketAdvanceOk() {
      let b = resource.data;
      let a = request.resource.data;
      let s = get(pSession(b.sessionId)).data;
      return a.keys().hasOnly(['roundId','sessionId','totalCardCount','playerCount','totalPot','jackpot'])
        && isRoundId(a.roundId)
        && a.totalCardCount == 0 && a.playerCount == 0 && a.totalPot == 0 && a.jackpot == 0
        && !exists(pResv(a.roundId)) && existsAfter(pResv(a.roundId))
        && s.roundId == b.roundId
        && (s.status == 'ended' || s.status == 'force_ended')
        && s.settlementInProgress == false
        && s.resultEndAt != null && request.time >= s.resultEndAt;
    }
    function marketUserUpdateOk() {
      let b = resource.data;
      let a = request.resource.data;
      return (b.sessionId == null && a.sessionId == null && a.roundId == b.roundId
                && a.totalCardCount > b.totalCardCount && marketPurchaseOk())
          || (b.sessionId == null && a.sessionId == null && a.roundId == b.roundId
                && a.totalCardCount < b.totalCardCount && marketReleaseOk())
          || (b.sessionId is string && a.sessionId == null && a.roundId != b.roundId && marketAdvanceOk());
    }

    match /settings/{docId} {
      allow read: if isLoggedIn();
      allow create: if isAdmin();
      allow update: if
        (docId == 'house' && isLoggedIn()
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['balance'])
          && houseMirrorsUserOk())
        || (docId == 'cardMarket' && isLoggedIn() && marketUserUpdateOk())
        || isAdmin();
      allow delete: if isAdmin();
    }

    // ═════════════════════════════════════════════════════════════════════
    // sessions/{sessionId}
    // ═════════════════════════════════════════════════════════════════════
    // IN-SESSION purchase counters. State (waiting + > LOCK_SECONDS left) is tested at the CALL SITE
    // so a locked/active/finished session rejects the write with 0 accesses spent.
    // Accesses: get+getAfter(users/{me}) = 2.
    function sessionPurchaseOk() {
      let b = resource.data;
      let a = request.resource.data;
      let n = a.totalCardCount - b.totalCardCount;
      let v = cardValueOf(b);   // the SESSION's price — immutable for non-admins (affectedKeys below), so never client-controlled
      let cost = stakeFor(n, v);
      let paid = get(pUser(request.auth.uid)).data.balance - getAfter(pUser(request.auth.uid)).data.balance;
      return a.diff(b).affectedKeys().hasOnly(['totalCardCount','playerCount','totalPot','jackpot'])
        && isCardValue(v)
        && n >= 1 && n <= MAX_USER_CARDS()
        && a.totalCardCount <= MAX_SESSION_CARDS()
        && (a.playerCount - b.playerCount == 0 || a.playerCount - b.playerCount == 1)
        && a.totalPot - b.totalPot == cost
        && a.jackpot - b.jackpot == jackpotShare(cost)
        && paid == cost;
    }
    // IN-SESSION release (leave & refund) while the session is still 'waiting'.
    // Accesses: get(order) + existsAfter(order) = 2.
    function sessionReleaseOk(sessionId) {
      let b = resource.data;
      let a = request.resource.data;
      let o = get(pOrder(b.roundId, request.auth.uid)).data;
      return a.diff(b).affectedKeys().hasOnly(['totalCardCount','playerCount','totalPot','jackpot'])
        && o.sessionId == sessionId
        && !existsAfter(pOrder(b.roundId, request.auth.uid))
        && b.totalCardCount - a.totalCardCount == o.ticketCount
        && b.playerCount - a.playerCount == 1
        && b.totalPot - a.totalPot == o.stake
        && b.jackpot - a.jackpot == jackpotShare(o.stake);
    }
    // ACTIVATION FALLBACK: normally the admin browser does this itself (attaches any still-pending card
    // orders for the round, THEN flips status — see the client's _adminTryActivate()), which is why this
    // branch only opens once ACTIVATE_GRACE_SECONDS have passed with nobody having done it yet. There is
    // no server-side scheduler on the Spark plan, so activation has always depended on SOME client's JS
    // timer noticing the countdown hit zero; gating this to admin-only made that ONE admin browser tab a
    // single point of failure (background-tab timer throttling, a sleeping laptop, etc. all silently stall
    // it). Opening a narrow, late fallback to any logged-in player closes that gap the same way
    // marketAdvanceOk() already lets any player open the next round, at the cost of a small, bounded risk:
    // a buyer whose card purchase never self-attached AND who is also offline past the grace window could
    // miss this specific round (their order is still safely on file for manual admin resolution — nothing
    // is lost, just not auto-included). Restricted to exactly the two fields this transition touches.
    // Accesses: 0.
    function sessionActivateOk() {
      let b = resource.data;
      let a = request.resource.data;
      return a.diff(b).affectedKeys().hasOnly(['status','startTime'])
        && b.status == 'waiting'
        && a.status == 'active'
        && b.playerCount >= 1
        && request.time >= b.countdownEnd + duration.value(ACTIVATE_GRACE_SECONDS(), 's');
    }
    // A claim write is one of two shapes, both self-service and both requiring the caller to be a
    // registered player in THIS session:
    //   (a) propose a claim to be judged  — touches only pendingClaim
    //   (b) self-record an immediate false-claim disqualification (one strike, no refund)
    // The cheap key checks run first; exists(player) (1 access) only runs for a genuine claim write.
    function isValidClaimSubmit(sessionId) {
      let before = resource.data;
      let after  = request.resource.data;
      let changed = after.diff(before).affectedKeys();
      return isLoggedIn()
        && before.status == 'active'
        && before.winnerId == null
        && (
          (changed.hasOnly(['pendingClaim'])
            && after.pendingClaim != null
            && (before.pendingClaim == null || before.pendingClaim.uid == request.auth.uid)
            && after.pendingClaim.uid == request.auth.uid)
          ||
          (changed.hasOnly(['disqualifiedUids'])
            && after.disqualifiedUids.hasAll(before.get('disqualifiedUids', []))
            && request.auth.uid in after.disqualifiedUids
            && after.disqualifiedUids.size() <= before.get('disqualifiedUids', []).size() + 1)
        )
        && exists(pPlayer(sessionId, request.auth.uid));
    }
    // Creating a session consumes the forming round: it must carry that round's id and totals, and
    // the market doc must switch to this session in the SAME request (no half-created state).
    // Accesses: get+getAfter(market) = 2 (+2 for isAdmin, evaluated first).
    //   cardValue 10    : the session inherits the round's id and running totals (pre-session orders attach to it).
    //   cardValue 5 | 30: pre-session purchases were made at 10 ETB and are refunded, never repriced or counted, so the
    //                     session starts on a NEW round (reservation doc created in the same request, absent before /
    //                     present after) with every counter at 0, and records the old round in repricedFromRoundId.
    //                     Accesses: +2 (exists/existsAfter reservations) => 6 for the session-create op.
    function sessionCreateLinksOk(sessionId) {
      let a = request.resource.data;
      let m0 = get(pMarket()).data;
      let m1 = getAfter(pMarket()).data;
      return m0.sessionId == null && m1.sessionId == sessionId
        && (a.cardValue == CARD_PRICE()
              ? (a.roundId == m0.roundId && m1.roundId == m0.roundId
                  && a.totalCardCount == m0.totalCardCount && a.playerCount == m0.playerCount
                  && a.totalPot == m0.totalPot && a.jackpot == m0.jackpot)
              : (isRoundId(a.roundId) && a.roundId != m0.roundId && m1.roundId == a.roundId
                  && a.repricedFromRoundId == m0.roundId
                  && !exists(pResv(a.roundId)) && existsAfter(pResv(a.roundId))
                  && a.totalCardCount == 0 && a.playerCount == 0 && a.totalPot == 0 && a.jackpot == 0
                  && m1.totalCardCount == 0 && m1.playerCount == 0 && m1.totalPot == 0 && m1.jackpot == 0));
    }

    match /sessions/{sessionId} {
      allow read: if isLoggedIn();
      allow create: if isAdmin()
        && request.resource.data.keys().hasAll([
          'status','sessionNumber','pattern','totalPot','jackpot','playerCount','totalCardCount','roundId','cardValue',
          'deckSeed','calledNumbers','currentNumber','lastSequence',
          'callerToken','callerUid','countdownEnd','createdAt',
          'startTime','endTime','resultEndAt','winnerId','winnerName',
          'winnerPrize','winnerPaid','winnerCardId','winnerCardNumbers','pendingClaim',
          'settlementInProgress','disqualifiedUids'
        ])
        && request.resource.data.status == 'waiting'
        && request.resource.data.calledNumbers == []
        && request.resource.data.winnerId == null
        && request.resource.data.winnerCardId == null
        && request.resource.data.winnerCardNumbers == null
        && request.resource.data.disqualifiedUids == []
        && isCardValue(request.resource.data.cardValue)
        && request.resource.data.sessionNumber is int
        && request.resource.data.sessionNumber > 0
        && request.resource.data.deckSeed is int
        && request.resource.data.deckSeed > 0
        && request.resource.data.totalCardCount <= MAX_SESSION_CARDS()
        && sessionCreateLinksOk(sessionId);
      // admin covers: skip countdown, on-time auto-activate, caller token acquire, number calling,
      // force-end / settle, claim approve/reject, payouts — all run from an authenticated admin browser.
      // sessionActivateOk() is the one exception: a LATE (grace-window-expired) activation any logged-in
      // player may perform if no admin browser got to it, so the round doesn't stay stuck on 00:00.
      allow update: if
        (resource.data.status == 'waiting'
          && request.resource.data.get('totalCardCount', 0) > resource.data.get('totalCardCount', 0)
          && request.time < resource.data.countdownEnd - duration.value(LOCK_SECONDS(), 's')
          && isLoggedIn() && sessionPurchaseOk())
        || (resource.data.status == 'waiting'
          && request.resource.data.get('totalCardCount', 0) < resource.data.get('totalCardCount', 0)
          && isLoggedIn() && sessionReleaseOk(sessionId))
        || isValidClaimSubmit(sessionId)
        || (isLoggedIn() && sessionActivateOk())
        || isAdmin();
      allow delete: if isAdmin();

      match /players/{uid} {
        // cardNumbers is a SNAPSHOT (cardCatalog stays authoritative for winner verification), but
        // each element must at least carry the cardId it belongs to and 25 cells. 0 accesses.
        function snapAt(p, i) {
          return p.cardIds.size() <= i
            || (p.cardNumbers[i].cardId == p.cardIds[i] && p.cardNumbers[i].numbers.size() == 25);
        }
        // every snapshot that already existed must be byte-identical after an update
        function sameSnap(p, b, i) {
          return b.cardNumbers.size() <= i || p.cardNumbers[i] == b.cardNumbers[i];
        }
        // Player doc must mirror a PAID, ASSIGNED order of this exact session. Access: getAfter(order) = 1.
        function playerFromOrderOk(sessionId, uid) {
          let p = request.resource.data;
          let o = getAfter(pOrder(p.roundId, uid)).data;
          return p.keys().hasOnly(['uid','phone','roundId','ticketCount','stake','cardIds','cardNumbers','joinedAt'])
            && p.uid == uid
            && o.uid == uid && o.roundId == p.roundId
            && o.sessionId == sessionId && o.status == 'assigned'
            && p.cardIds == o.cardIds && p.ticketCount == o.ticketCount && p.stake == o.stake
            && p.cardNumbers is list && p.cardNumbers.size() == p.ticketCount
            && snapAt(p, 0) && snapAt(p, 1) && snapAt(p, 2) && snapAt(p, 3) && snapAt(p, 4)
            && snapAt(p, 5) && snapAt(p, 6) && snapAt(p, 7) && snapAt(p, 8) && snapAt(p, 9)
            && snapAt(p, 10) && snapAt(p, 11) && snapAt(p, 12) && snapAt(p, 13) && snapAt(p, 14)
            && snapAt(p, 15) && snapAt(p, 16) && snapAt(p, 17) && snapAt(p, 18) && snapAt(p, 19);
        }
        allow read: if isOwner(uid) || isAdmin();
        allow create: if (isOwner(uid) && playerFromOrderOk(sessionId, uid)) || isAdmin();
        // append only: snapshots already stored can never be changed (immutable card numbers)
        allow update: if (isOwner(uid)
            && sameSnap(request.resource.data, resource.data, 0) && sameSnap(request.resource.data, resource.data, 1)
            && sameSnap(request.resource.data, resource.data, 2) && sameSnap(request.resource.data, resource.data, 3)
            && sameSnap(request.resource.data, resource.data, 4) && sameSnap(request.resource.data, resource.data, 5)
            && sameSnap(request.resource.data, resource.data, 6) && sameSnap(request.resource.data, resource.data, 7)
            && sameSnap(request.resource.data, resource.data, 8) && sameSnap(request.resource.data, resource.data, 9)
            && sameSnap(request.resource.data, resource.data, 10) && sameSnap(request.resource.data, resource.data, 11)
            && sameSnap(request.resource.data, resource.data, 12) && sameSnap(request.resource.data, resource.data, 13)
            && sameSnap(request.resource.data, resource.data, 14) && sameSnap(request.resource.data, resource.data, 15)
            && sameSnap(request.resource.data, resource.data, 16) && sameSnap(request.resource.data, resource.data, 17)
            && sameSnap(request.resource.data, resource.data, 18) && sameSnap(request.resource.data, resource.data, 19)
            && playerFromOrderOk(sessionId, uid))
          || isAdmin();
        // leave: only together with deleting the order. Access: existsAfter(order) = 1.
        allow delete: if (isOwner(uid) && !existsAfter(pOrder(resource.data.roundId, uid))) || isAdmin();
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // deposits / withdrawals / refunds / passwordResetRequests / supportTickets  (unchanged)
    // ═════════════════════════════════════════════════════════════════════
    match /deposits/{docId} {
      allow read: if isLoggedIn()
        && (resource.data.uid == request.auth.uid || isAdmin());
      allow create: if isLoggedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.status == 'pending'
        && request.resource.data.amount is number
        && request.resource.data.amount >= 10
        && request.resource.data.keys().hasAll(['uid','phone','amount','status']);
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }

    match /withdrawals/{docId} {
      allow read: if isLoggedIn()
        && (resource.data.uid == request.auth.uid || isAdmin());
      allow create: if isLoggedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.status == 'pending'
        && request.resource.data.amount is number
        && request.resource.data.amount >= 10
        && request.resource.data.keys().hasAll(['uid','phone','fullName','amount','status']);
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }

    // Force-end / no-winner sweeps write uid = the REFUNDED PLAYER's uid while request.auth.uid is the
    // admin running the sweep — create must allow isAdmin() on its own.
    match /refunds/{docId} {
      allow read: if isLoggedIn()
        && (resource.data.uid == request.auth.uid || isAdmin());
      allow create: if isAdmin()
        || (isLoggedIn()
          && request.resource.data.uid == request.auth.uid
          && request.resource.data.keys().hasAll(['uid','sessionId','amount']));
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }

    // Create is open to logged-out callers by design — someone submitting this is, by definition,
    // unable to log in.
    match /passwordResetRequests/{docId} {
      allow read: if isAdmin();
      allow create: if request.resource.data.keys().hasAll(['phone','uid','requestedAt','status'])
        && request.resource.data.status == 'pending'
        && request.resource.data.phone is string
        && request.resource.data.phone.size() > 0
        && request.resource.data.phone.size() <= 20;
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }

    match /supportTickets/{docId} {
      allow read: if isAdmin();
      allow create: if isLoggedIn()
        && request.resource.data.keys().hasAll(['ticketId','uid','phone','category','message','status','createdAt'])
        && request.resource.data.status == 'pending'
        && request.resource.data.message is string
        && request.resource.data.message.size() <= 500;
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }

  }
}
