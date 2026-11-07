# Sourced installer reader. No external command or eval: render.sh's marked literal block is the sole name table.
# read <renderer> commits name/category arrays only on success; clear/apply/render derive their frames from them.
aify_registry_categories_refuse() { printf 'registry pair categories: %s\n' "$1" >&2; return 78; }
aify_registry_pair_categories_read() {
  [ "$#" -eq 1 ] && [ -r "$1" ] || { aify_registry_categories_refuse 'renderer is unreadable'; return 78; }
  local line name category extra phase=before begins=0 ends=0 seen=' '
  local -a recomputed=() clients=() overrides=() names=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [ "$line" = '# AIFY_REGISTRY_PAIR_CATEGORIES_BEGIN' ]; then
      begins=$((begins+1)); [ "$phase" = before ] && [ "$begins" -eq 1 ] || { aify_registry_categories_refuse 'duplicate or unordered start marker'; return 78; }
      phase=data; continue
    fi
    if [ "$line" = '# AIFY_REGISTRY_PAIR_CATEGORIES_END' ]; then
      ends=$((ends+1)); [ "$phase" = data ] && [ "$ends" -eq 1 ] || { aify_registry_categories_refuse 'duplicate or unordered end marker'; return 78; }
      phase=after; continue
    fi
    [ "$phase" = data ] || continue
    IFS=' ' read -r name category extra <<< "$line"
    if [[ ! "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || [ -n "$extra" ] || [ "$line" != "$name $category" ]; then aify_registry_categories_refuse 'malformed NAME CATEGORY row'; return 78; fi
    case "$seen" in *" $name "*) aify_registry_categories_refuse "duplicate name $name"; return 78 ;; esac
    seen="$seen$name "; names+=("$name")
    case "$category" in
      recomputed) recomputed+=("$name") ;;
      client-specific) clients+=("$name") ;;
      service-override) overrides+=("$name") ;;
      *) aify_registry_categories_refuse "unknown category $category"; return 78 ;;
    esac
  done < "$1"
  if [ "$begins" -ne 1 ] || [ "$ends" -ne 1 ] || [ "$phase" != after ]; then aify_registry_categories_refuse 'expected unique ordered start/end markers'; return 78; fi
  if [ "${#recomputed[@]}" -eq 0 ] || [ "${#clients[@]}" -eq 0 ] || [ "${#overrides[@]}" -eq 0 ]; then aify_registry_categories_refuse 'each category must have a declared member'; return 78; fi
  AIFY_REGISTRY_PAIR_NAMES=("${names[@]}")
  AIFY_REGISTRY_RECOMPUTED_NAMES=("${recomputed[@]}")
  AIFY_REGISTRY_CLIENT_NAMES=("${clients[@]}")
  AIFY_REGISTRY_OVERRIDE_NAMES=("${overrides[@]}")
}
aify_registry_render_pairs() {
  local name
  AIFY_REGISTRY_RENDER_PAIRS=()
  for name in "${AIFY_REGISTRY_PAIR_NAMES[@]}"; do AIFY_REGISTRY_RENDER_PAIRS+=("$name=${!name}"); done
}
aify_registry_install_pairs_clear() {
  local name
  for name in "${AIFY_REGISTRY_RECOMPUTED_NAMES[@]}"; do printf -v "$name" '%s' ''; done
}
aify_registry_install_pairs_apply() {
  local pair key accepted seen=' '
  while IFS= read -r pair; do
    case "$pair" in *=*) ;; *) continue ;; esac
    key="${pair%%=*}"
    for accepted in "${AIFY_REGISTRY_RECOMPUTED_NAMES[@]}" "${AIFY_REGISTRY_OVERRIDE_NAMES[@]}"; do
      if [ "$key" = "$accepted" ]; then printf -v "$key" '%s' "${pair#*=}"; seen="$seen$key "; break; fi
    done
  done <<< "$1"
  for key in "${AIFY_REGISTRY_RECOMPUTED_NAMES[@]}"; do
    case "$seen" in *" $key "*) ;; *) printf 'install.sh: the registry reader gave no %s\n' "$key" >&2; return 78 ;; esac
  done
}
