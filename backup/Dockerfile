FROM postgres:18.6-bookworm

RUN apt-get update \
    && apt-get install --no-install-recommends -y age awscli jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY backup/run-backup.sh /backup/run-backup.sh
RUN chmod 0755 /backup/run-backup.sh

CMD ["sh", "/backup/run-backup.sh"]
