# TETRI.S — Serverless P2P Multiplayer Tetris

게임 서버 없이 **WebRTC(P2P)** 로 동작하는 멀티플레이 테트리스. GitHub Pages 같은 정적 호스팅에 그대로 배포하고, 시그널링만 **무료 Firebase Realtime Database** 로 처리합니다.

## 동작 원리

- **직접 구현한 WebRTC 시그널링**(`public/p2p.js`)이 Firebase Realtime DB 로 offer/answer/ICE 후보를 교환하고, 이후 데이터는 피어 간 WebRTC 데이터채널로 직접 오갑니다.
  - 과거 [Trystero](https://github.com/dmotz/trystero) 를 썼으나 이 환경에서 연결 협상이 재시도 폭주·데이터채널 미개통으로 실패해, **글레어 없는 결정적 단일 연결**(두 피어 중 id 작은 쪽이 offer)로 직접 구현해 교체했습니다. Firebase 는 `public/vendor/firebase.js` 로 로컬 번들.
- 방장(방 생성자)이 **호스트 권한**을 갖고 로스터 관리 · 카운트다운 · 승자 판정을 담당합니다.
- 보드 상태 갱신과 공격 라인(쓰레기 줄)은 **피어끼리 직접** 주고받습니다.
- 방코드 = Trystero roomId. 방장이 만든 6자리 코드를 공유해 참가합니다.
- **솔로 플레이**: 로비의 `🎮 솔로 플레이` 버튼으로 네트워크 없이 혼자 연습 가능(공격 없음, 게임오버 시 점수·재도전).
- **모바일 터치 컨트롤**: 터치 기기(`pointer: coarse`)에서 화면 하단 조작 버튼(◀ ↻ ▶ ▼ HOLD ⤓DROP) 자동 표시. 데스크톱에는 영향 없음.
- **호스트 마이그레이션**: 방장이 나가면 남은 인원 중 결정적으로 새 방장을 선출해 방/게임을 유지(로비·게임 중 모두).

> **왜 Firebase인가?** 공개 무설정 시그널링(BitTorrent 트래커 / Nostr 릴레이 / MQTT 브로커)은
> 실측 결과 모두 불안정했습니다(트래커 403·사멸, Nostr 릴레이 signaling rate-limit, MQTT 타임아웃).
> Firebase Realtime DB 는 무료 티어로 충분하고 rate-limit 없이 안정적이며, **직접 운영하는 서버가 없습니다.**

## ⚙️ 필수 설정 (Firebase, 약 5분)

1. [Firebase 콘솔](https://console.firebase.google.com/) → **프로젝트 추가**.
2. 좌측 **Build → Realtime Database → 데이터베이스 만들기**.
   - 위치 선택 후 **테스트 모드로 시작** (또는 아래 규칙 직접 설정).
3. 생성되면 나오는 **데이터베이스 URL** 을 복사.
   예: `https://tetris-xxxx-default-rtdb.firebaseio.com`
   (아시아 지역은 `...asia-southeast1.firebasedatabase.app` 형태)
4. `public/game.js` 상단의 `FIREBASE_DB_URL` 값을 그 URL 로 교체.

### Realtime Database 보안 규칙

Trystero 는 인증 없이 `__trystero__` 경로에 시그널링 데이터를 쓰므로, 해당 경로 읽기/쓰기를 허용해야 합니다:

```json
{
  "rules": {
    "__trystero__": {
      ".read": true,
      ".write": true
    }
  }
}
```

> ⚠️ 이 경로는 인증 없이 공개 읽기/쓰기입니다(시그널링 메타데이터만 오감). 실제 게임 데이터는 P2P로만 흐릅니다.

## 로컬 실행

```bash
npm run dev        # public/ 을 정적 서버로 서빙 (npx serve)
```

브라우저 두 개(또는 두 기기)에서 열어 한쪽은 방 만들기, 다른 쪽은 코드로 참가.
(`file://` 직접 열기는 ES 모듈 제약으로 안 되니 http 서버로 여세요.)

## GitHub Pages 배포

1. 이 저장소를 GitHub 에 push (`main` 브랜치).
2. **Settings → Pages → Source: GitHub Actions** 로 설정.
3. `.github/workflows/deploy.yml` 이 `public/` 를 자동 배포합니다.

`FIREBASE_DB_URL` 은 클라이언트에 하드코딩되지만, RTDB URL 은 공개돼도 무방합니다(보안은 위 규칙으로 통제).

## 🌐 TURN 서버 (연결 실패 시 — 선택이지만 강력 권장)

STUN 만으로는 **대칭 NAT / 회사망 / 엄격한 방화벽** 뒤 사용자끼리 연결이 실패합니다.
이 경우 TURN(중계) 서버가 필요합니다.

> ⚠️ 흔히 쓰이던 무료 공개 TURN(`openrelay.metered.ca` / `openrelayproject`)은 **현재 죽어서
> relay 후보를 전혀 주지 않습니다**(브라우저 ICE 수집으로 실측 확인). 넣어봐야 소용없고
> 오히려 ICE 완료를 지연시킵니다. 그래서 코드에서 제거했습니다.

**작동시키는 법 (무료, 약 2분):**
1. https://dashboard.metered.ca 무료 가입 (TURN 월 50GB 무료).
2. 대시보드에서 **TURN Credentials** 의 `username` / `password` 확인.
3. `public/game.js` 상단의 `TURN_USERNAME` / `TURN_CREDENTIAL` 에 붙여넣기.

→ 값을 채우면 `global.relay.metered.ca` TURN 이 활성화되어 연결 성공률이 크게 올라갑니다.
비워두면 STUN 만 사용합니다(대부분의 가정용 공유기 환경은 STUN 으로 충분).

## 한계 (P2P 구조상)

- **공개 방 목록 없음**: 방 열거가 불가능 → 코드 공유 방식만 지원.
- **대칭 NAT**: 위 TURN 설정 전에는 일부 네트워크에서 연결 실패 가능.
- **신뢰 모델**: 각 클라이언트가 자기 점수를 계산·전송하므로 치팅 방지는 없습니다(캐주얼 전제).

## 파일 구조

```
public/
  index.html   # UI (ES 모듈로 game.js 로드)
  game.js      # 테트리스 엔진 + 렌더 + Trystero P2P 네트워킹
  style.css
.github/workflows/deploy.yml   # Pages 자동 배포
```

## 검증 현황

- ✅ 모듈 로드 / Firebase SDK 번들 / 방 생성→대기실→방장 컨트롤 (헤드리스 Chrome 실측)
- ⚠️ 실제 2인 Firebase 연결은 본인 Firebase DB URL 설정 후 브라우저 2개로 확인하세요
  (테스트 환경에선 실 DB 자격증명이 없어 미검증).
