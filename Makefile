# Bookshelf follows the service-project convention: `build` makes one
# executable, `install` puts it in ~/.local/bin, the config template in
# ~/.config/bookshelf/ and the env file in ~/.secrets/, `uninstall` removes the
# executable, `clean` the build. No systemd unit is created or restarted:
# serviceman tracks the service and restarts it when the binary is replaced.

BIN         := bookshelf
PREFIX      ?= $(HOME)/.local
BINDIR      := $(PREFIX)/bin
CONFIG_DIR  := $(HOME)/.config/$(BIN)
CONFIG      := $(CONFIG_DIR)/config.json
TEMPLATE    := config.template.json
SECRETS_DIR := $(HOME)/.secrets
ENV_DEFAULT := $(SECRETS_DIR)/$(BIN).env
ENV_EXAMPLE := .env.example

build: node_modules
	bun scripts/build.ts --outfile=$(BIN)

node_modules: package.json bun.lock
	bun install --frozen-lockfile
	@touch node_modules

# An existing config is never changed without asking: Keep (default),
# Update (add the template's missing settings; nothing is removed or changed),
# or Replace (after a timestamped backup). Without a terminal it is kept.
#
# The env file's location is asked for (default ~/.secrets/bookshelf.env). An
# existing env file is never touched; a new one is copied from .env.example.
install: build
	install -Dm755 $(BIN) $(BINDIR)/$(BIN)
	@echo "installed $(BINDIR)/$(BIN)"
	@set -e; \
	if [ ! -e "$(CONFIG)" ]; then \
		install -Dm644 $(TEMPLATE) "$(CONFIG)"; \
		echo "installed $(CONFIG) from $(TEMPLATE)"; \
	elif [ ! -t 0 ]; then \
		echo "kept the existing $(CONFIG) (no terminal to ask; run make install from a terminal to update or replace it)"; \
	else \
		printf '%s already exists. [K]eep it, [u]pdate it with new fields, or [r]eplace it (a backup is kept)? ' "$(CONFIG)"; \
		read answer; \
		case "$$answer" in \
		u|U) $(BINDIR)/$(BIN) config update "$(CONFIG)" ;; \
		r|R) backup="$(CONFIG).$$(date +%Y%m%d-%H%M%S).bak"; \
		     cp -p "$(CONFIG)" "$$backup"; \
		     install -m644 $(TEMPLATE) "$(CONFIG)"; \
		     echo "replaced $(CONFIG) (backup: $$backup)" ;; \
		*)   echo "kept $(CONFIG)" ;; \
		esac; \
	fi
	@set -e; \
	envfile="$(ENV_DEFAULT)"; \
	if [ -t 0 ]; then \
		printf 'Env file for secrets [%s]: ' "$(ENV_DEFAULT)"; \
		read answer; \
		case "$$answer" in \
		"")   ;; \
		"~")  envfile="$(HOME)" ;; \
		"~"/*) envfile="$(HOME)/$${answer#\~/}" ;; \
		*)    envfile="$$answer" ;; \
		esac; \
	fi; \
	envdir=$$(dirname "$$envfile"); \
	if [ ! -d "$$envdir" ]; then \
		mkdir -p "$$envdir"; \
		if [ "$$envdir" = "$(SECRETS_DIR)" ]; then chmod 700 "$$envdir"; fi; \
		echo "created $$envdir"; \
	fi; \
	if [ -e "$$envfile" ]; then \
		echo "kept the existing $$envfile"; \
	else \
		install -m600 $(ENV_EXAMPLE) "$$envfile"; \
		echo "installed $$envfile from $(ENV_EXAMPLE)"; \
	fi; \
	echo "give the service this env file with serviceman's New service form or M-x set-env-file"

# The config and env files are left alone.
uninstall:
	rm -f $(BINDIR)/$(BIN)
	@echo "removed $(BINDIR)/$(BIN); config kept in $(CONFIG_DIR), env file kept"

clean:
	rm -f $(BIN)

test: node_modules
	bun test

typecheck: node_modules
	bun run typecheck

.PHONY: build install uninstall clean test typecheck
