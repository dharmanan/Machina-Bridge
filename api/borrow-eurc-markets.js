import { handleArcEurcMarkets } from './_lib/borrow-eurc-markets.js'
export default async function handler(req,res) {
  return handleArcEurcMarkets({method:req.method,query:req.query,send({status,headers,body}){
    for(const [name,value] of Object.entries(headers)) res.setHeader(name,value)
    return res.status(status).send(body)
  }})
}
