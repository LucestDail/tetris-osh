// ═══════════════════════════════════════════════════════════════
//  P2P 시그널링 — Firebase Realtime DB 로 직접 구현한 WebRTC 메시
//  (Trystero 대체: 글레어 없는 결정적 단일 연결 + 확실한 정리)
//
//  Trystero 호환 API 를 노출한다:
//    const room = joinRoom({ appId, turnConfig, log }, roomCode)
//    const [send, onMessage] = room.makeAction('name')
//    room.onPeerJoin(fn) / room.onPeerLeave(fn) / room.getPeers() / room.leave()
//
//  시그널링 경로: p2p/<room>/peers/<id>          (presence)
//                 p2p/<room>/inbox/<to>/<from>/{offer,answer,cand/*}
//  연결 규칙: 두 피어 중 id 가 작은 쪽이 offer 를 만든다(글레어 방지).
// ═══════════════════════════════════════════════════════════════

import {
  initializeApp, getDatabase, ref, onValue, onChildAdded,
  set, push, remove, onDisconnect,
} from './vendor/firebase.js';

// 랜덤 피어 ID (Trystero selfId 대체)
export const selfId = (() => {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const rnd = (crypto && crypto.getRandomValues)
    ? crypto.getRandomValues(new Uint8Array(20))
    : Array.from({ length: 20 }, () => Math.floor(Math.random() * 256));
  for (let i = 0; i < 20; i++) s += c[rnd[i] % c.length];
  return s;
})();

let fbApp = null;
function getApp(dbUrl) {
  if (!fbApp) fbApp = initializeApp({ databaseURL: dbUrl }, 'p2p');
  return fbApp;
}

export function joinRoom(config, roomCode) {
  const dbUrl = config.appId;
  const turn = config.turnConfig || [];
  const log = config.log || (() => {});
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    ...turn,
  ];

  const db = getDatabase(getApp(dbUrl));
  const base = `p2p/${roomCode}`;
  const me = selfId;

  const peers = new Map();        // peerId -> { pc, dc, open, pendingCand[], sendQueue[] }
  const actions = new Map();      // name -> handler(data, peerId)
  let onJoin = () => {};
  let onLeave = () => {};
  let left = false;

  // ── presence ──
  const myPresence = ref(db, `${base}/peers/${me}`);
  set(myPresence, { t: Date.now() });
  onDisconnect(myPresence).remove();
  log(`P2P 입장 room=${roomCode} self=${me.slice(0, 4)}`);

  // 다른 피어 감시 → 연결 시작
  onValue(ref(db, `${base}/peers`), (snap) => {
    if (left) return;
    const val = snap.val() || {};
    for (const id of Object.keys(val)) {
      if (id !== me && !peers.has(id)) connectTo(id);
    }
    for (const id of [...peers.keys()]) {
      if (!val[id]) { log(`피어 presence 사라짐: ${id.slice(0, 4)}`); teardown(id); }
    }
  });

  function connectTo(peerId) {
    const initiator = me < peerId;   // 결정적: 작은 id 가 offer
    log(`🔗 연결 시작 ${peerId.slice(0, 4)} (내가 ${initiator ? 'offer' : 'answer'})`);
    const pc = new RTCPeerConnection({ iceServers });
    const entry = { pc, dc: null, open: false, pendingCand: [], sendQueue: [] };
    peers.set(peerId, entry);

    // 나 → 상대 inbox 로 ICE 후보 전송
    const myCandOut = `${base}/inbox/${peerId}/${me}/cand`;
    pc.onicecandidate = (e) => {
      if (e.candidate) push(ref(db, myCandOut), JSON.stringify(e.candidate.toJSON()));
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed' || s === 'closed') { log(`  ICE ${s}: ${peerId.slice(0, 4)}`); }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { log(`  연결 실패: ${peerId.slice(0, 4)}`); teardown(peerId); }
    };

    function bindChannel(dc) {
      entry.dc = dc;
      dc.onopen = () => {
        entry.open = true;
        log(`📡 데이터채널 열림 → ${peerId.slice(0, 4)} 연결 완료!`);
        for (const m of entry.sendQueue) { try { dc.send(m); } catch (_) {} }
        entry.sendQueue = [];
        onJoin(peerId);
      };
      dc.onclose = () => teardown(peerId);
      dc.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        const h = actions.get(msg.a);
        if (h) h(msg.d, peerId);
      };
    }

    // 내 inbox 에서 offer/answer/cand 수신
    const inbox = `${base}/inbox/${me}/${peerId}`;
    onValue(ref(db, `${inbox}/offer`), async (s) => {
      if (left || !s.val() || initiator) return;
      try {
        await pc.setRemoteDescription(JSON.parse(s.val()));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await set(ref(db, `${base}/inbox/${peerId}/${me}/answer`), JSON.stringify(pc.localDescription.toJSON()));
        drainCand(pc, entry);
      } catch (e) { log(`offer 처리 오류 ${String(e).slice(0, 40)}`); }
    });
    onValue(ref(db, `${inbox}/answer`), async (s) => {
      if (left || !s.val() || !initiator || pc.currentRemoteDescription) return;
      try {
        await pc.setRemoteDescription(JSON.parse(s.val()));
        drainCand(pc, entry);
      } catch (e) { log(`answer 처리 오류 ${String(e).slice(0, 40)}`); }
    });
    onChildAdded(ref(db, `${inbox}/cand`), (s) => {
      if (left || !s.val()) return;
      const cand = JSON.parse(s.val());
      if (pc.remoteDescription) pc.addIceCandidate(cand).catch(() => {});
      else entry.pendingCand.push(cand);
    });

    if (initiator) {
      const dc = pc.createDataChannel('game', { ordered: true });
      bindChannel(dc);
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => set(ref(db, `${base}/inbox/${peerId}/${me}/offer`), JSON.stringify(pc.localDescription.toJSON())))
        .catch((e) => log(`offer 생성 오류 ${String(e).slice(0, 40)}`));
    } else {
      pc.ondatachannel = (e) => bindChannel(e.channel);
    }
  }

  function drainCand(pc, entry) {
    for (const c of entry.pendingCand) pc.addIceCandidate(c).catch(() => {});
    entry.pendingCand = [];
  }

  function teardown(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    peers.delete(peerId);
    try { entry.dc && entry.dc.close(); } catch (_) {}
    try { entry.pc && entry.pc.close(); } catch (_) {}
    // 시그널링 잔재 정리
    remove(ref(db, `${base}/inbox/${me}/${peerId}`)).catch(() => {});
    onLeave(peerId);
  }

  // ── Trystero 호환 API ──
  function makeAction(name) {
    const send = (data, target) => {
      const payload = JSON.stringify({ a: name, d: data });
      const targets = target ? [target] : [...peers.keys()];
      for (const id of targets) {
        const entry = peers.get(id);
        if (!entry) continue;
        if (entry.open && entry.dc && entry.dc.readyState === 'open') {
          try { entry.dc.send(payload); } catch (_) {}
        } else {
          entry.sendQueue.push(payload);
        }
      }
    };
    const onMessage = (fn) => actions.set(name, fn);
    return [send, onMessage];
  }

  function leave() {
    left = true;
    for (const id of [...peers.keys()]) teardown(id);
    remove(myPresence).catch(() => {});
    remove(ref(db, `${base}/inbox/${me}`)).catch(() => {});
  }

  const getPeers = () => {
    const o = {};
    for (const [id, e] of peers) o[id] = e.pc;
    return o;
  };

  return {
    makeAction,
    onPeerJoin: (fn) => { onJoin = fn; },
    onPeerLeave: (fn) => { onLeave = fn; },
    getPeers,
    leave,
  };
}
