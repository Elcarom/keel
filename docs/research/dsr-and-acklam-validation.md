# Research: Peter J. Acklam's Inverse Normal CDF & Bailey and López de Prado Deflated Sharpe Ratio

## 1. Peter J. Acklam Inverse Standard Normal CDF

### Primary Source Citation

- **Author**: Peter J. Acklam
- **Title**: _An algorithm for computing the inverse normal cumulative distribution function_ (2003).
- **Online Archive / Reference**: http://web.archive.org/web/20151030215612/http://home.online.no/~pjacklam/notes/invnorm/

### Formulation

The standard normal cumulative distribution function is defined as:
$$\Phi(x) = \frac{1}{\sqrt{2\pi}} \int_{-\infty}^{x} e^{-t^2/2} \, dt$$

The inverse normal CDF (quantile function / probit function) computes $x = \Phi^{-1}(p)$ for $0 < p < 1$.

Acklam partitions the domain into three regions using break-points $p_{\text{low}} = 0.02425$ and $p_{\text{high}} = 1 - p_{\text{low}} = 0.97575$:

#### Central Region ($p_{\text{low}} \le p \le p_{\text{high}}$):

Let $q = p - 0.5$ and $r = q^2$.
$$x = q \cdot \frac{((((a_1 r + a_2) r + a_3) r + a_4) r + a_5) r + a_6}{((((b_1 r + b_2) r + b_3) r + b_4) r + b_5) r + 1}$$

Coefficients:

- $a_1 = -3.969683028665376 \times 10^1$
- $a_2 = 2.209460984245205 \times 10^2$
- $a_3 = -2.759285104469687 \times 10^2$
- $a_4 = 1.383577518672690 \times 10^2$
- $a_5 = -3.066479806614716 \times 10^1$
- $a_6 = 2.506628277459239$
- $b_1 = -5.447609879822406 \times 10^1$
- $b_2 = 1.615858368580409 \times 10^2$
- $b_3 = -1.556989798598866 \times 10^2$
- $b_4 = 6.680131188771972 \times 10^1$
- $b_5 = -1.328068155288572 \times 10^1$

#### Lower Tail Region ($p < p_{\text{low}}$):

Let $q = \sqrt{-2\ln(p)}$.
$$x = \frac{((((c_1 q + c_2) q + c_3) q + c_4) q + c_5) q + c_6}{(((d_1 q + d_2) q + d_3) q + d_4) q + 1}$$

Coefficients:

- $c_1 = -7.784894002430293 \times 10^{-3}$
- $c_2 = -3.223964580411365 \times 10^{-1}$
- $c_3 = -2.400758277161838$
- $c_4 = -2.549732539343734$
- $c_5 = 4.374664141464968$
- $c_6 = 2.938163982698783$
- $d_1 = 7.784695709041462 \times 10^{-3}$
- $d_2 = 3.224671290700398 \times 10^{-1}$
- $d_3 = 2.445134137142996$
- $d_4 = 3.754408661907416$

#### Upper Tail Region ($p > p_{\text{high}}$):

Exploiting symmetry:
Let $q = \sqrt{-2\ln(1 - p)}$.
$$x = -\frac{((((c_1 q + c_2) q + c_3) q + c_4) q + c_5) q + c_6}{(((d_1 q + d_2) q + d_3) q + d_4) q + 1}$$

### Known-Value Reference Check

| Probability $p$ | Theoretical $\Phi^{-1}(p)$ |
| :-------------- | :------------------------- |
| $0.500$         | $0.000000$                 |
| $0.900$         | $1.281552$                 |
| $0.950$         | $1.644854$                 |
| $0.975$         | $1.959964$                 |
| $0.990$         | $2.326348$                 |
| $0.025$         | $-1.959964$                |

---

## 2. Bailey and López de Prado Deflated Sharpe Ratio (DSR)

### Primary Source Citation

- **Authors**: David H. Bailey and Marcos López de Prado
- **Title**: _The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-Normality_
- **Journal**: _The Journal of Portfolio Management_, Vol. 40, No. 5 (2014), pp. 94–107.
- **SSRN**: https://ssrn.com/abstract=2460551

### Mathematical Formulation

The Deflated Sharpe Ratio (DSR) computes the probability that the estimated Sharpe Ratio ($\widehat{\text{SR}}$) is statistically significant after accounting for:

1. **Sample length** ($N$)
2. **Skewness** ($\widehat{\gamma}_3$) and **kurtosis** ($\widehat{\gamma}_4$)
3. **Multiple testing selection bias** over $K$ trials (variance of Sharpe ratios $\sigma_{\text{SR}}^2$ across trials)

#### Standard Error of the Sharpe Ratio (Mertens, 2002):

$$\sigma_{\widehat{\text{SR}}} = \sqrt{\frac{1 - \widehat{\gamma}_3 \widehat{\text{SR}} + \frac{\widehat{\gamma}_4 - 1}{4} \widehat{\text{SR}}^2}{N - 1}}$$

#### Expected Maximum Sharpe Ratio Under the Null ($\text{SR}^*$):

Under the null hypothesis that true performance is zero, testing $K$ independent trials yields expected maximum Sharpe ratio:
$$\text{SR}^* = \sqrt{V} \left( (1 - \gamma) \Phi^{-1}\left(1 - \frac{1}{K}\right) + \gamma \Phi^{-1}\left(1 - \frac{1}{K \cdot e}\right) \right)$$
where:

- $\gamma \approx 0.5772156649$ is the Euler-Mascheroni constant
- $e \approx 2.7182818284$ is Euler's number
- $V = \sigma_{\text{SR}}^2$ is the variance of the Sharpe ratios across the $K$ trials.

#### Deflated Sharpe Ratio (DSR):

$$\text{DSR} = \Phi\left( \frac{(\widehat{\text{SR}} - \text{SR}^*) \sqrt{N - 1}}{\sqrt{1 - \widehat{\gamma}_3 \widehat{\text{SR}} + \frac{\widehat{\gamma}_4 - 1}{4} \widehat{\text{SR}}^2}} \right)$$

DSR represents the probability $P(\widehat{\text{SR}} > \text{SR}^*)$, providing an honest statistical confidence level between 0 and 1.
