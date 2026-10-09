# Stakeholder demo on CSC Rahti

A temporary deployment for showing the app to stakeholders. It is not the
production setup of `docs/DEPLOYMENT.md`: one PostgreSQL pod, and one app pod
with the web and worker containers sharing one media volume. Files:
`deploy/rahti/demo.yaml`.

## Log in

1. Open https://console.2.rahti.csc.fi, sign in with CSC or Haka.
2. User menu, "Copy login command", "Display Token". Run the `oc login --token=... --server=https://api.2.rahti.csc.fi:6443` command it shows. Tokens expire after some hours, so this step is always needed.
3. `oc project <project>`

## First deployment

Set the names once per shell:

```bash
PROJECT=<rahti project>
HOST=<name>.2.rahtiapp.fi
REG=image-registry.apps.2.rahti.csc.fi
```

Push the images (built locally from the repository root):

```bash
docker build -f docker/web.Dockerfile -t dialect-web:demo .
docker build -f docker/worker.Dockerfile -t dialect-worker:demo .
docker login -u unused -p "$(oc whoami -t)" $REG
for image in dialect-web:demo dialect-worker:demo postgres:17; do
  docker tag $image $REG/$PROJECT/$image && docker push $REG/$PROJECT/$image
done
```

Create the secret (the values are not stored in any file):

```bash
oc create secret generic dialect-secrets \
  --from-literal=POSTGRES_PASSWORD="$PGPASS" \
  --from-literal=DATABASE_URL="postgresql://dialect:$PGPASS@postgres:5432/dialect_study" \
  --from-literal=ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --from-literal=ADMIN_SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY"
```

Apply the resources:

```bash
sed -e "s/PROJECT/$PROJECT/g" -e "s/HOST/$HOST/g" deploy/rahti/demo.yaml | oc apply -f -
oc rollout status deploy/postgres && oc rollout status deploy/app
```

Seed the study content once, through a port forward to the database:

```bash
oc port-forward deploy/postgres 15432:5432 &
DATABASE_URL="postgresql://dialect:$PGPASS@localhost:15432/dialect_study" pnpm --filter @dialect/db exec tsx src/seed/index.ts
kill %1
```

Check: `curl https://$HOST/api/health/ready` answers `"status":"ready"`.

## Pause after the meeting

```bash
oc scale deploy/app deploy/postgres --replicas=0
```

The volumes, secret and route stay; the URL shows "Application is not
available". To bring it back: `oc scale deploy/postgres deploy/app --replicas=1`.

## Remove everything

```bash
sed -e "s/PROJECT/$PROJECT/g" -e "s/HOST/$HOST/g" deploy/rahti/demo.yaml | oc delete -f -
oc delete secret dialect-secrets
```

Deleting the volumes deletes every recording and the database.

## Reset the demo database (keeps images, route and secrets)

Needed when the seeded study content changes (consent, questionnaires): a
published version is immutable, and the seed only inserts missing rows.

```bash
oc scale deploy/app --replicas=0
oc exec deploy/postgres -- psql -U dialect -d postgres -c "DROP DATABASE dialect_study WITH (FORCE)" -c "CREATE DATABASE dialect_study OWNER dialect"
oc scale deploy/app --replicas=1          # the init container applies all migrations
oc port-forward deploy/postgres 15432:5432   # in its own terminal
DATABASE_URL="postgresql://dialect:$PGPASS@localhost:15432/dialect_study" pnpm --filter @dialect/db exec tsx src/seed/index.ts
```

Then set the study settings again (Settings page, or `PUT /api/admin/settings`):
`allowNewSessions: true`, `demoPublic: true`, `autoQueueAsr: true`. The seed
defaults already have the English vocabulary test off and 5 reviewed recordings.

## Pitfalls seen on 2026-10-09

- A new image with the same tag is not pulled unless `imagePullPolicy: Always`
  is set (it is, in demo.yaml). Before that, a restart kept running the old image.
- `TRUST_PROXY` must be `true` behind the Rahti router, otherwise every visitor
  shares one rate-limit bucket (readiness then reports a warning).
- The output review needs `AUTO_TRANSLATE_AFTER_ASR=true`; without it nothing is
  ever ready and every review is stored as `unavailable`.
- The front page needs `ALLOW_EXAMPLE_TEXT_SESSIONS=true` while the seeded example
  texts are in place, or research sessions are refused.
- Do not stop a port forward with `pkill -f "oc port-forward"` in the same shell
  command that started it: the pattern matches that shell and kills it.
- A WAV from OpenAI TTS has placeholder RIFF and data sizes (0xFFFFFFFF). The
  upload check rejects it as truncated, correctly; fix the two size fields before
  using such a file as a test recording.
- Old media files of a reset database stay on the `media` volume (nothing refers
  to them). Remove them by hand before new sessions exist, or delete the volume.
