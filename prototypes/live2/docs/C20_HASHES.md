# C2.0 · Контрольні SHA-256

Вхідні дані й результати хешуються від КАНОНІЧНОГО JSON (ключі відсортовано, без пробілів), тому хеш не залежить від gzip-мітки часу. Повні значення — у `fixtures/c20/<id>/meta.json` і `tests/golden/c20/*.json`.

## Вхідні дані наборів

| Набір | klines (усі ряди) | kb (16 стратегій і параметри) | sk (ваги сигналів) | книги заявок | моменти оцінювання |
|---|---|---|---|---|---|
| D1 | `0cf0a41d45312ecdaae51fc5c7adaf6125843a27de71b3274f753270e3b31dbe` | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | `7f4bfc7178e1e6ac713e06eb58645a35fea08b2ad91f669abfa6333ab6186699` | немає (історичних книг не існує) | `a90fec0e6924acb0ba457fb315fa8ca81c3ec6efd14a2907176a9beb800ab897` |
| D2 | `dc6ded209e36cd0996656d9dd3094262b435f1a588f4f3a25f771fc0f8373582` | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | `7f4bfc7178e1e6ac713e06eb58645a35fea08b2ad91f669abfa6333ab6186699` | немає (історичних книг не існує) | `c00e0d2db3e75fd217c851207cfea08eaf40c2168dcd29832002c942ad1abf60` |
| D3 | `2ea5cc3eb47b75e7b14574a2e203f5e6c10159f6c300820b74eb0b02bc0dc93b` | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | `7f4bfc7178e1e6ac713e06eb58645a35fea08b2ad91f669abfa6333ab6186699` | немає (історичних книг не існує) | `3565dbf187539b6adfdb2772960aa9db6258769ddb8d110d3ee573586e7ab949` |
| D4 | `20293ebc8f00a574b8ae2e2f97953a94394d8a1921b14399b2de959b0f8650e3` | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | `7f4bfc7178e1e6ac713e06eb58645a35fea08b2ad91f669abfa6333ab6186699` | `83ddf5b70659074536391785b4e23e11ff0df1026a392353fdad15f56c0591ab` | `0af178706007a0ba7c332a874323b99653468c2038e3c1327dbc33f6b9cd16d5` |
| D5 | `34b4e04eb31133883e34789d659c2a22a94b3be71c62117c8d23501b0425b8fc` | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | `7f4bfc7178e1e6ac713e06eb58645a35fea08b2ad91f669abfa6333ab6186699` | немає (історичних книг не існує) | `c71d1136424a0341a709ec15295fe250947101542b5661b413fe4ea53cd7400e` |
| D6 | `9b659d3ef10635ba391f2fb074e32cb2f5416419672265e9dac7422b20fc3ab4` | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | `7f4bfc7178e1e6ac713e06eb58645a35fea08b2ad91f669abfa6333ab6186699` | немає (історичних книг не існує) | `598fc59035cc9e74ae82deda5a2d08f99b8c7a4f07295437b2775b2e1967dc34` |

## Еталонні результати чинного рушія (за варіантами)

| Варіант | Конфігурація (ефективна) | Початковий стан | Підсумковий стан (6 файлів) | Таблиця 48 рахунків | Кроків |
|---|---|---|---|---|---|
| D1 | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | порожній (новий раунд) | `91f406b3b0b7eda0482955ed1efdd6d9622f2e94022cc8d3b71bfa43d751eaef` | `49bffe431e8b2ddda6677841d6284ab94153eef4d0da3b00deb10ee096018617` | 217 |
| D2 | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | порожній (новий раунд) | `8c446448196a79cfd8db66b8802a86f90e7a0376ec27303b87985b741dbc5d3e` | `aea07249e32dd7d3dd98b1c44a019b5d4b0ad0e572b1ed266f47f44cf5792510` | 217 |
| D3 | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | порожній (новий раунд) | `230630b98153546d4a4f357b90b0f4fe45e97d6005c6dde837f5043da6574aa8` | `6f42423bfe3abfd4f1679296354920ef1706ffa8477af45b1ef866811679dac7` | 217 |
| D4 | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | порожній (новий раунд) | `5809c43a01dd019365d79a23cac65410ada0c7fc9636e0052daf7bdec8b276f4` | `99fa1edbd4af8de08ef1906eab965504ea82b39dbf31ab79cee9c86c6311a49c` | 109 |
| D5 | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | порожній (новий раунд) | `c112c61eb843947e99f61a86ac5fcb34ea7a73a8727de28064b8931e839f43fd` | `56094f6452a006fc82226e5b885972396e9841640d1edc53bc2258a2ffb40778` | 217 |
| D6 | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | порожній (новий раунд) | `c3a68409570402aa1f5def282eab7f0220fd8053d07f54499754a24c85b1d4a4` | `47121bcf1556cb3a6fdb9b5c45314bd1a2f9b267aef3d0328d0ddef73fd3810f` | 289 |
| D1n | `67d517bb123e8622983ca7681ee42eed0699186f707548ed47c7a0cc21363b5b` | порожній (новий раунд) | `b0145cd1f3792fcfb2e458ee1ec1a545f8ebf50c1cda8e7f2365103503328d86` | `4b09459a4a61b667265f5a2cef36eafb71901287b9ae5690f71c1308ee393f9b` | 217 |
| D2r | `03b92509d37ca2f3a989a24b48e3f0c301defeb2e7adf0e5e460fda9a0237e10` | порожній (новий раунд) | `e28c5a07d8bb55733b108f02b270c972005cf2b2fef85f163da513cb22414656` | `1c0778e71ddda6dec2fa0a81fdda797c67503e1a1f023875aa17cfba3bcc33a9` | 217 |
| D3w | `776b373e08e9fa089f3a3da11aa1ae112a668accfcefe12bfd122e719b64b3f6` | `9dc46dbddacaf9b864576960b4b5ac7e7f2077c9aa4265be47da3dac5a8c5c79` | `230630b98153546d4a4f357b90b0f4fe45e97d6005c6dde837f5043da6574aa8` | `6f42423bfe3abfd4f1679296354920ef1706ffa8477af45b1ef866811679dac7` | 144 |

Ланцюжки відбитків стану й результату на кожному кроці — поля `step_state_sha256` і `step_result_sha256` у `tests/golden/c20/<варіант>.json` (перший розбіжний крок вказується в повідомленні тесту).

## Інші еталони

- Сітка `Costs` на реальних книгах D4 (690 значень): `94f03cc6bcde59b8715c7a119c2f147dfeb5a7f0dc8b3cebec38541485ae1570`
- Хеші вихідного коду 18 ключових функцій: файл `tests/golden/engine_hashes.json`, SHA-256 файла `034fc72b84f62e9c30ca73aacd7d0327b55e0d026dbed7a42ab7111c9fbc343c`

## SHA-256 файлів еталонів (байти)

| Файл | SHA-256 |
|---|---|
| tests/golden/c20/D1.json | `240f7be16e23536aa4a5c261e69a98962709d59fc984dfff23c8b54c57422455` |
| tests/golden/c20/D1n.json | `49811fd74ae5e8c0539ae0d9e2078b70cb94672ac6f253d9593848c5712fb388` |
| tests/golden/c20/D2.json | `e63092bc930cab3b1ed0ba52d7d90c016e49393de797f079fd2f853b46b7be46` |
| tests/golden/c20/D2r.json | `26e421d8d86487a5dd933b601edf97a8ecee5b11e6cbe4c91212386634909d4b` |
| tests/golden/c20/D3.json | `f2066c04c41b51e00006d1a5bcb326e77e26367e339088f48f0db29a252891f5` |
| tests/golden/c20/D3w.json | `487b8b5fee15c26cd6a774b1a3fccbd42dc05d534e20f1c2820a7757149ef47d` |
| tests/golden/c20/D4.json | `45e827077da77b92ab377c8f2d43146e228112dd18118676645247f0b0937d49` |
| tests/golden/c20/D5.json | `37e01205dfbc08b54bee6d43ffb0b53e5d26097c7ea4018c01d8bc8ae548a3f4` |
| tests/golden/c20/D6.json | `1aa0122e9888b9307ad122e0fe0f1b47b1bc055f64e43ae36704d13c395e0f2a` |
| tests/golden/c20/costs_grid.json | `1bc12133545c291c3c1a9299d913b3e431f0a77278b04984144233134f433140` |
| fixtures/c20/D1/kb.json | `3f69d64347285a197b0c392d4947a749ff1eefc163c0d12d856a1dc4dfce6f20` |
| fixtures/c20/D1/klines.json.gz | `c32f5f8fa556fcd1996984426e52e2ebd358aa7a46de6d43b00a2b6af8300e9a` |
| fixtures/c20/D1/meta.json | `6005da0c5135c30e985b1a0f9a2bb6added3b4eaaf45fec50041918e31bcead1` |
| fixtures/c20/D1/sk.json | `28be3d51c16c7bfd1745969695d5c1286eaaaed577a34d27bc15b55eb5376070` |
| fixtures/c20/D2/kb.json | `3f69d64347285a197b0c392d4947a749ff1eefc163c0d12d856a1dc4dfce6f20` |
| fixtures/c20/D2/klines.json.gz | `10648e775e52ee65f3f0c16bd138d2228a7e9a66d2ecf29059fb3fe19f59690a` |
| fixtures/c20/D2/meta.json | `66cc7daae6f7147912f178e1400e036aeebbeb012cfcaa81f62a8bbb1720b1d1` |
| fixtures/c20/D2/sk.json | `28be3d51c16c7bfd1745969695d5c1286eaaaed577a34d27bc15b55eb5376070` |
| fixtures/c20/D3/kb.json | `3f69d64347285a197b0c392d4947a749ff1eefc163c0d12d856a1dc4dfce6f20` |
| fixtures/c20/D3/klines.json.gz | `4e304670c976071a5427d5a7a4e70d2c0103fa6a4462ec8cb5df5c4d29028a0f` |
| fixtures/c20/D3/meta.json | `2751bdc343097da00a2c50e11564d3f28fa1108b19e19e2c46846ecaad323cf8` |
| fixtures/c20/D3/sk.json | `28be3d51c16c7bfd1745969695d5c1286eaaaed577a34d27bc15b55eb5376070` |
| fixtures/c20/D4/books.json | `37179ad8e7622f83898bfe00fedc9c52adb4cd08b3c49e246d90e64d3397a6c2` |
| fixtures/c20/D4/kb.json | `3f69d64347285a197b0c392d4947a749ff1eefc163c0d12d856a1dc4dfce6f20` |
| fixtures/c20/D4/klines.json.gz | `fc00516eaa68e7fe73d5e72aa09dd650ed9b9f9749ae2769b4696ccfa7ba7986` |
| fixtures/c20/D4/meta.json | `ed916fc4d1ff049c82b2eb973774aba6424e3f2f80cadcb2f4f02ed9157c5a1f` |
| fixtures/c20/D4/sk.json | `28be3d51c16c7bfd1745969695d5c1286eaaaed577a34d27bc15b55eb5376070` |
| fixtures/c20/D5/kb.json | `3f69d64347285a197b0c392d4947a749ff1eefc163c0d12d856a1dc4dfce6f20` |
| fixtures/c20/D5/klines.json.gz | `80cbf991dce42644f320b5e0e6408c6116a3d2ccd3f598b7eb7ca1272142bc53` |
| fixtures/c20/D5/meta.json | `c54994325f85bdbefb7c3de26b852aa94d32476abfffb6e252f64eb00aebc391` |
| fixtures/c20/D5/sk.json | `28be3d51c16c7bfd1745969695d5c1286eaaaed577a34d27bc15b55eb5376070` |
| fixtures/c20/D6/kb.json | `3f69d64347285a197b0c392d4947a749ff1eefc163c0d12d856a1dc4dfce6f20` |
| fixtures/c20/D6/klines.json.gz | `e37bba726870fd60b4f51dcb20428cd233abfddeebb38c25bd86f838fe3087f0` |
| fixtures/c20/D6/meta.json | `c726cbf78eafb2658b27b14fcac591b9842d65dd7f131969c0ea3f47d552abff` |
| fixtures/c20/D6/sk.json | `28be3d51c16c7bfd1745969695d5c1286eaaaed577a34d27bc15b55eb5376070` |
| fixtures/c20/D3w_initial/* (6 файлів, канонічно) | `9dc46dbddacaf9b864576960b4b5ac7e7f2077c9aa4265be47da3dac5a8c5c79` |
