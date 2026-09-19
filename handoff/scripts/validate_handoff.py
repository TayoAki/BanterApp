"""Offline handoff integrity check. This does not run the app or an AI provider."""
from pathlib import Path
import json, hashlib, re

ROOT=Path(__file__).resolve().parents[1]
load=lambda p: json.loads((ROOT/p).read_text())
sha=lambda b: hashlib.sha256(b).hexdigest()
norm=lambda s: re.sub(r'\s+',' ',s).strip()

def validate_contract(schema,data):
    """Check the JSON Schema keywords used in this handoff; not a general validator."""
    if 'anyOf' in schema:
        for branch in schema['anyOf']:
            try: validate_contract(branch,data);return
            except AssertionError: pass
        raise AssertionError('No anyOf branch matched')
    allowed={'$schema','type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','enum','const'}
    assert set(schema)<=allowed, 'Unsupported schema keyword'
    kind=schema['type']
    checks={'object':lambda v:isinstance(v,dict),'array':lambda v:isinstance(v,list),
            'string':lambda v:isinstance(v,str),'integer':lambda v:type(v) is int,
            'boolean':lambda v:type(v) is bool,'null':lambda v:v is None}
    assert kind in checks and checks[kind](data),f'Invalid {kind}: {data!r}'
    if 'const' in schema: assert type(data) is type(schema['const']) and data==schema['const']
    if 'enum' in schema: assert data in schema['enum']
    if kind=='object':
        assert set(schema['required'])<=set(data),'Missing required field'
        if schema.get('additionalProperties') is False:assert set(data)<=set(schema['properties']),'Extra field'
        for key,value in data.items():validate_contract(schema['properties'][key],value)
    if kind=='array':
        assert schema.get('minItems',0)<=len(data)<=schema.get('maxItems',float('inf'))
        for item in data:validate_contract(schema['items'],item)
    if kind=='string':assert schema.get('minLength',0)<=len(data)<=schema.get('maxLength',float('inf'))
    if kind=='integer':assert schema.get('minimum',float('-inf'))<=data<=schema.get('maximum',float('inf'))

def main():
    c=load('content/source-corpus.json')
    f=load('content/frameworks.json')
    prompts=load('content/daily-prompts.json')
    lessons=load('content/lessons.json')
    assert len(c['sources'])==10
    assert sum(s['page_count'] for s in c['sources'])==44
    assert len(c['examples'])==20
    ex={x['example_id']:x for x in c['examples']}
    fs={x['id']:x for x in f}
    assert len(fs)==10 and 'F04' not in fs and 'F09' not in fs
    assert len({p['id'] for p in prompts})==len(prompts)==30
    assert len({l['id'] for l in lessons})==len(lessons)==30
    for src in c['sources']:
        assert sha((ROOT/'content/source-pdfs'/src['filename']).read_bytes())==src['sha256_pdf']
    for e in ex.values():
        src=next(s for s in c['sources'] if s['filename']==e['source_filename'])
        text=norm(' '.join(p['text_extracted'] for p in src['pages'] if p['page'] in e['source_pages']))
        assert e['text_verbatim'] in text,e['example_id']
        assert sha(e['text_verbatim'].encode())==e['text_sha256']
        assert (ROOT/'content/verbatim-examples.md').read_text().count('> '+e['text_verbatim']+'\n')==1
    for ff in f:
        src=next(s for s in c['sources'] if s['framework_id']==ff['id'])
        assert ff['source_statement_verbatim'] in norm(src['pages'][0]['text_extracted'])
        assert len({x['id'] for x in ff['criteria']})==3
        for eid in ff['example_ids']:assert ex[eid]['framework_id']==ff['id']
    for p in prompts:
        assert p['publication_status']=='draft'
        assert p['criterion_ids']==[x['id'] for x in fs[p['framework_id']]['criteria']]
        assert all(ex[eid]['framework_id']==p['framework_id'] for eid in p['example_ids'])
    ps={p['id']:p for p in prompts}
    for l in lessons:
        assert ps[l['prompt_id']]['framework_id']==l['framework_id']
        assert ex[l['primary_example_id']]['framework_id']==l['framework_id']
        assert l['publication_status']=='draft'
    a=load('fixtures/attempt.json');ev=load('fixtures/evaluation.json');rw=load('fixtures/rewrite.json')
    assert a['framework_id']==ev['framework_id']==rw['framework_id']
    assert a['transcript_revision']==ev['transcript_revision']==rw['transcript_revision']
    ff=fs[a['framework_id']]
    assert {x['criterion_id'] for x in ev['criteria']}=={x['id'] for x in ff['criteria']}
    for cr in ev['criteria']:
        assert all(q in a['confirmed_transcript'] for q in cr['evidence_quotes'])
        assert cr['score']==0 or cr['evidence_quotes']
    assert ev['strength']['evidence_quote'] in a['confirmed_transcript']
    assert sum(x['score'] for x in ev['criteria'])==6
    source_ids={x['id'] for x in ff['criteria'] if x['origin']=='source_rule'}
    assert sum(x['score'] for x in ev['criteria'] if x['criterion_id'] in source_ids)==6
    for fact in rw['preserved_facts']:
        assert fact['input_quote'] in a['confirmed_transcript']
        assert fact['rewrite_quote'] in rw['rewrite_text']
    for kind,data in [('evaluation',ev),('rewrite',rw)]:
        validate_contract(load(f'contracts/{kind}.schema.json'),data)
    validate_contract(load('contracts/rewrite-verification.schema.json'),{'verdict':'pass','issues':[]})
    validate_contract(load('contracts/partner.schema.json'),{'partner_reply':'I have absolutely done that.','conversation_state':'continuing','boundary_signal':'none'})
    # Negative controls: the fixture checker must reject invalid grades and unknown fields.
    invalid=json.loads(json.dumps(ev));invalid['criteria'][0]['score']=4
    extra=dict(ev);extra['total']=9
    for bad in [invalid,extra]:
        try:validate_contract(load('contracts/evaluation.schema.json'),bad)
        except AssertionError:pass
        else:raise AssertionError('Invalid fixture accepted')
    for p in ROOT.rglob('*.json'):json.loads(p.read_text())
    for image in ['01-voice-practice.png','02-feedback-progress.png']:
        assert (ROOT/'design'/image).read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    for p in ROOT.rglob('*.md'):
        assert p.read_text().count('```')%2==0,str(p)
    print('PASS: 10 PDF hashes; 44 source pages; 20 exact quote records; 10 source statements and rubrics; 30 prompts; 30 lesson seeds; fixtures against all 4 response contracts using a keyword-subset validator; negative controls; fixture evidence and totals; 2 mockup boards; Markdown fences.')
    print('NOT TESTED: mobile runtime, model quality, transcription, playback, accounts, billing, notifications, backend, or device integrations.')

if __name__=='__main__':main()
