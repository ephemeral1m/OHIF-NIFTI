#!/usr/bin/env bash
set -euo pipefail
source_dir=/home/ant/nv-reason-colipri-val/ct
destination=/home/ubuntu/ohif-ai/nifti-demo/hospital-10-20261008
known=/home/ant/nv-reason-colipri-val/results/vanilla_known_hosts
ssh_options=(-o UserKnownHostsFile="$known" -o StrictHostKeyChecking=yes -o BatchMode=yes)
cd "$source_dir"
files=()
for n in $(seq -w 1 10); do files+=("HOSP0${n}.nii.gz"); done
for file in "${files[@]}"; do test -f "$file"; done
hashes=/home/ant/nv-reason-colipri-val/results/hospital10_vanilla_sha256.txt
sha256sum "${files[@]}" > "$hashes"
ssh "${ssh_options[@]}" ubuntu@100.110.156.71 "umask 077; mkdir -p '$destination/.incoming'"
rsync -tv --partial --checksum --chmod=F600 -e "ssh -o UserKnownHostsFile=$known -o StrictHostKeyChecking=yes -o BatchMode=yes" \
  "${files[@]}" "$hashes" "ubuntu@100.110.156.71:$destination/.incoming/"
ssh "${ssh_options[@]}" ubuntu@100.110.156.71 "cd '$destination/.incoming' && sha256sum -c hospital10_vanilla_sha256.txt"
echo 'Ten files transferred and SHA-256 verified in staging.'
