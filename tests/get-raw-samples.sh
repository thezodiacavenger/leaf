#!/bin/bash
# Downloads one RAW sample per brand into scratchpad/raws
S=/path/to/leaf-test-data
mkdir -p "$S/raws"
fetch() { curl -sS --fail -o "$S/raws/$1" "$2" && echo "ok $1" || echo "FAIL $1"; }
fetch canon_r6.CR3      "https://raw.pixls.us/getfile.php/4659/nice/Canon%20-%20EOS%20R6%20-%203:2.CR3" &
fetch canon_5d4.CR2     "https://raw.pixls.us/getfile.php/981/nice/Canon%20-%20EOS%205D%20Mark%20IV%20-%20sRAW2%20(sRAW)%20(3:2).CR2" &
fetch nikon_z6.NEF      "https://raw.pixls.us/getfile.php/3587/nice/Nikon%20-%20Z%206%20-%2012bit%2012bit%20compressed%20(3:2).NEF" &
fetch sony_a7m3.ARW     "https://raw.pixls.us/getfile.php/2415/nice/Sony%20-%20ILCE-7M3%20-%2012bit%2012bit%20compressed%20(3:2).ARW" &
fetch fuji_xt3.RAF      "https://raw.pixls.us/getfile.php/2783/nice/Fujifilm%20-%20X-T3%20-%2014bit%2014bit%20compressed%20(3:2).RAF" &
fetch olympus_em1.ORF   "https://raw.pixls.us/getfile.php/3800/nice/Olympus%20-%20E-M1MarkIII%20-%2016bit%20(4:3).ORF" &
fetch lumix_g9.RW2      "https://raw.pixls.us/getfile.php/3218/nice/Panasonic%20-%20DC-G9%20-%203:2.RW2" &
fetch pentax_k1.DNG     "https://raw.pixls.us/getfile.php/2470/nice/Pentax%20-%20K-1%20-%2014bit%20(3:2).DNG" &
wait
ls -la "$S/raws"
