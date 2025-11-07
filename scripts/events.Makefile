# Metro Maker Event Pool Queries
# Usage: make -f events.Makefile <target>
#
# Examples:
#   make -f events.Makefile recent-events
#   make -f events.Makefile event-types
#   make -f events.Makefile hourly-stats

.PHONY: help recent-events all-events event-types daily-summary hourly-stats

help:
	@echo "Metro Maker Event Pool Queries"
	@echo ""
	@echo "Available targets:"
	@echo "  recent-events   - Events from the last hour"
	@echo "  all-events      - Last 100 events"
	@echo "  event-types     - Count by event type"
	@echo "  daily-summary   - Events per day (last 30 days)"
	@echo "  hourly-stats    - Events per hour (last 24h)"
	@echo ""
	@echo "Set EVENT_API_TOKEN environment variable before running"

recent-events:
	@./query-events.sh recent

all-events:
	@./query-events.sh all

event-types:
	@./query-events.sh types

daily-summary:
	@./query-events.sh summary

hourly-stats:
	@node query-events.js hourly | jq '.'

# Custom query example
# Usage: make -f events.Makefile custom-query QUERY="SELECT * WHERE type='click'"
custom-query:
	@./query-events.sh "$(QUERY)"
