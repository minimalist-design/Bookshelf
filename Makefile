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

# Bold text for headings and option keys, only when printing to a terminal.
STYLE := if [ -t 1 ]; then b=$$(tput bold 2>/dev/null || true); r=$$(tput sgr0 2>/dev/null || true); else b=; r=; fi

# An existing config is never changed without asking: Update (default: adds the
# template's missing settings and never changes or removes existing ones, so a
# new Bookshelf never runs without its new settings), Keep, or Replace (after a
# timestamped backup; the old config's port is kept). Without a terminal it is kept.
#
# The env file's location is asked for (default ~/.secrets/bookshelf.env); a new
# one is copied from .env.example. An existing one gets the same choice: Update
# (default: appends the variables it lacks, empty), Keep, or Replace (a fresh
# copy of .env.example that keeps the values of variables still in it; no backup
# is made, since the file holds secrets). Without a terminal it is kept.
install: build
	install -Dm755 $(BIN) $(BINDIR)/$(BIN)
	@echo "installed $(BINDIR)/$(BIN)"
	@set -e; $(STYLE); \
	if [ ! -e "$(CONFIG)" ]; then \
		install -Dm644 $(TEMPLATE) "$(CONFIG)"; \
		echo "installed $(CONFIG) from $(TEMPLATE)"; \
	elif [ ! -t 0 ]; then \
		echo "kept the existing $(CONFIG) (no terminal to ask; run make install from a terminal to update or replace it)"; \
	else \
		echo; \
		echo "$${b}The config file already exists$${r}"; \
		echo "  $$($(BINDIR)/$(BIN) config version "$(CONFIG)")"; \
		echo; \
		echo "  $${b}u$${r}  Update   add the new settings from the template; existing values stay as they are (default)"; \
		echo "  $${b}k$${r}  Keep     leave the file exactly as it is"; \
		echo "  $${b}r$${r}  Replace  start over from the template; the old file is backed up and its port kept"; \
		echo; \
		while :; do \
			printf 'Choose [U/k/r]: '; \
			read answer || answer=k; \
			case "$$answer" in \
			""|u|U) $(BINDIR)/$(BIN) config update "$(CONFIG)"; break ;; \
			k|K)    echo "kept $(CONFIG)"; break ;; \
			r|R)    backup="$(CONFIG).$$(date +%Y%m%d-%H%M%S).bak"; \
			        cp -p "$(CONFIG)" "$$backup"; \
			        install -m644 $(TEMPLATE) "$(CONFIG)"; \
			        bun scripts/carry-port.ts "$$backup" "$(CONFIG)"; \
			        echo "replaced $(CONFIG) (backup: $$backup)"; break ;; \
			*)      echo "  Type u, k or r, or just press Enter to update." ;; \
			esac; \
		done; \
	fi
	@set -e; $(STYLE); \
	envfile="$(ENV_DEFAULT)"; \
	if [ -t 0 ]; then \
		echo; \
		echo "$${b}Env file for secrets$${r}"; \
		echo "  Press Enter to use $${b}$(ENV_DEFAULT)$${r}, or type another path."; \
		printf '  Path: '; \
		read answer || answer=; \
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
	if [ ! -e "$$envfile" ]; then \
		install -m600 $(ENV_EXAMPLE) "$$envfile"; \
		echo "installed $$envfile from $(ENV_EXAMPLE)"; \
	elif [ ! -t 0 ]; then \
		echo "kept the existing $$envfile (no terminal to ask; run make install from a terminal to update or replace it)"; \
	else \
		echo; \
		echo "$${b}The env file already exists$${r}"; \
		echo "  $$(bun scripts/env-file.ts status $(ENV_EXAMPLE) "$$envfile")"; \
		echo; \
		echo "  $${b}u$${r}  Update   add the variables missing from $(ENV_EXAMPLE); existing values stay as they are (default)"; \
		echo "  $${b}k$${r}  Keep     leave the file exactly as it is"; \
		echo "  $${b}r$${r}  Replace  start over from $(ENV_EXAMPLE); values of variables still in it are kept, no backup is made"; \
		echo; \
		while :; do \
			printf 'Choose [U/k/r]: '; \
			read answer || answer=k; \
			case "$$answer" in \
			""|u|U) bun scripts/env-file.ts update $(ENV_EXAMPLE) "$$envfile"; break ;; \
			k|K)    echo "kept $$envfile"; break ;; \
			r|R)    bun scripts/env-file.ts replace $(ENV_EXAMPLE) "$$envfile"; break ;; \
			*)      echo "  Type u, k or r, or just press Enter to update." ;; \
			esac; \
		done; \
	fi; \
	echo

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
