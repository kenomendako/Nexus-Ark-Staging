---
id: atelier-api-buttons
title: Atelier API buttons and Nexus Ark payloads
summary: アトリエPWAのAPI payload、scope、再送、成功/失敗表示を確認する。
applies_to:
  workspace_kinds: [persona, persona_project_read]
  keywords: [app, pwa, アプリ, webアプリ, api, nexus, capabilities, send_chat, write_event, read_items, write_items, payload, scope, token, 送信, ボタン, 権限, 記録, チャット, アイテム, エラー]
  require_keywords: true
priority: 99
max_chars: 1700
---

## API buttons
`GET status`: `persistent_emotions_available`/`persistent_emotions`は申告値/日時/参考値/表示状態。未申告≠0、期限切れ≠本人終了。`arousal_sample_count`:0=無記録、null=不明。閲覧専用。
`POST chat/thoughts/translate` owner_only: `{text}` -> `{text}`. Click sends masked thoughts (cost); no reply/signatures/retry/memory writes.

`/api/v1/rooms/{roomId}/`; `GET capabilities`; visible feedback/status area: send/success/partial/failure.
Scopes: capabilities; requested_scopes in `workspace/apps/<name>/nexus.json`; dream/episodic notes read-only.

Chat `{"message":"..."}`; `chat/regenerate` latest/no rerun. `chat/history`: music/notices, no RAW.
Event `{"event_type":"..."}`, never type/content. `items/actions` stable client_action_id: gift once, place/pickup inventory,
consume only `consume_location`.

`./_nexus/config` no-store; 401/403 once; 5xx stage/retry; 422 response fixes field.
Owner-only paid profile/image; apps denied. `client_request_id` exact replay. AI/manual明示保存
(`taste_profile` empty valid); no auto side effects.

Lite owner-only: `response-settings` GET revision; PUT `{key_name,model_name,enable_api_key_rotation,base_revision}`;
DELETE `{base_revision}`; stale `409`. `chat/history?include_thoughts=true`; Lite `{key/memo,food,autonomy/settings,
chat active/stop}`; `/api/v1/lite-travel/{standby,diagnostics,return}`. Grantsでowner-only開放不可、owner token要求禁止。 `temporary-location`: omit retains; `active:false` retains text/photo/name; clear explicit.
`saved` GET/POST; duplicate `409`; unsafe/missing image retains text+flag. `.../generate` paid
`{image_path,user_hint?,client_request_id}`; exact replay/no auto-regenerate. Draft generate/save/load; review/apply;
presence locks writes.
