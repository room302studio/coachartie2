# Backup database daily
cp -p packages/capabilities/data/coachartie.db "backups/coachartie-$(date +%Y%m%d).db"
